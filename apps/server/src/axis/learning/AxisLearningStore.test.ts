import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  AxisContextId,
  AxisLearningEvidence,
  AxisLearningEvidenceId,
  AxisLearningLifecycleEventId,
  AxisLearningProposalDraft,
  AxisLearningTransitionError,
  AxisLearningValidationError,
  AxisLearningVersionId,
} from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AxisLearningStore, layer as storeLayer } from "./AxisLearningStore.ts";

const testLayer = Layer.merge(
  SqlitePersistenceMemory,
  storeLayer.pipe(Layer.provide(SqlitePersistenceMemory)),
);
const layer = it.layer(testLayer);
const decodeEvidenceEffect = Schema.decodeUnknownEffect(AxisLearningEvidence);
const decodeProposalDraftEffect = Schema.decodeUnknownEffect(AxisLearningProposalDraft);

const evidence = Schema.decodeUnknownSync(AxisLearningEvidence)({
  id: "evidence_1",
  provenance: {
    contextId: "company_a",
    sourceKind: "thread-turn",
    sourceId: "thread-1:turn-1",
    provider: { environmentId: "local", instanceId: "codex_work" },
    observedAt: "2026-09-05T09:00:00.000Z",
    fingerprint: "sha256:evidence-1",
  },
  summary: "A focused verification step prevented a regression.",
  createdAt: "2026-09-05T09:01:00.000Z",
  expiresAt: "2026-10-05T09:01:00.000Z",
});

const proposalDraft = Schema.decodeUnknownSync(AxisLearningProposalDraft)({
  id: "proposal_1",
  contextId: "company_a",
  kind: "provider-skill",
  targetKey: "provider:codex_work:skill:verify",
  targetProvider: { environmentId: "local", instanceId: "codex_work" },
  title: "Add focused verification",
  rationale: "The same correction was needed repeatedly.",
  evidenceIds: [evidence.id],
  change: { op: "replace", path: "instructions", value: "Run the focused test first." },
});

const review = (eventId: string, createdAt: string, note?: string) => ({
  eventId: AxisLearningLifecycleEventId.make(eventId),
  actor: "user:owner",
  ...(note !== undefined ? { note } : {}),
  createdAt,
});

layer("AxisLearningStore", (it) => {
  it.effect("requires explicit review and activation, then supports audited rollback", () =>
    Effect.gen(function* () {
      const store = yield* AxisLearningStore;
      yield* store.recordEvidence(evidence);
      const proposal = yield* store.createProposal(proposalDraft, "2026-09-05T10:00:00.000Z");
      assert.equal(proposal.status, "draft");

      const prematureApproval = yield* Effect.flip(
        store.approve(
          proposal.id,
          AxisLearningVersionId.make("version_1"),
          review("event_premature", "2026-09-05T10:01:00.000Z"),
        ),
      );
      assert.instanceOf(prematureApproval, AxisLearningTransitionError);

      yield* store.submitForReview(
        proposal.id,
        review("event_submit_1", "2026-09-05T10:02:00.000Z"),
      );
      const version1 = yield* store.approve(
        proposal.id,
        AxisLearningVersionId.make("version_1"),
        review("event_approve_1", "2026-09-05T10:03:00.000Z", "Reviewed by owner."),
      );
      assert.equal(version1.approvedBy, "user:owner");
      assert.isTrue(
        Option.isNone(yield* store.getActive(AxisContextId.make("company_a"), version1.targetKey)),
      );

      yield* store.activate(version1.id, review("event_activate_1", "2026-09-05T10:04:00.000Z"));

      const secondDraft = yield* decodeProposalDraftEffect({
        ...proposalDraft,
        id: "proposal_2",
        title: "Refine focused verification",
      });
      const proposal2 = yield* store.createProposal(secondDraft, "2026-09-05T11:00:00.000Z");
      yield* store.submitForReview(
        proposal2.id,
        review("event_submit_2", "2026-09-05T11:01:00.000Z"),
      );
      const version2 = yield* store.approve(
        proposal2.id,
        AxisLearningVersionId.make("version_2"),
        review("event_approve_2", "2026-09-05T11:02:00.000Z"),
      );
      yield* store.activate(version2.id, review("event_activate_2", "2026-09-05T11:03:00.000Z"));
      const rolledBack = yield* store.rollback(
        version1.id,
        review("event_rollback", "2026-09-05T11:04:00.000Z"),
      );
      assert.equal(rolledBack.versionId, version1.id);

      const lifecycle = yield* store.listLifecycle(evidence.provenance.contextId);
      assert.deepEqual(
        lifecycle.map((event) => event.action),
        ["submitted", "approved", "activated", "submitted", "approved", "activated", "rolled-back"],
      );
      assert.equal(lifecycle.at(-1)?.previousVersionId, version2.id);
    }),
  );

  it.effect("keeps rejection durable and validates evidence context and retention", () =>
    Effect.gen(function* () {
      const store = yield* AxisLearningStore;
      const retainedEvidence = yield* decodeEvidenceEffect({
        ...evidence,
        id: "evidence_2",
        provenance: { ...evidence.provenance, fingerprint: "sha256:evidence-2" },
      });
      yield* store.recordEvidence(retainedEvidence);
      const invalidRetention = yield* Effect.flip(
        store.recordEvidence({
          ...retainedEvidence,
          id: AxisLearningEvidenceId.make("evidence_invalid_retention"),
          provenance: {
            ...retainedEvidence.provenance,
            fingerprint: "sha256:invalid-retention",
          },
          expiresAt: "2026-09-05T09:00:00.000Z",
        }),
      );
      assert.instanceOf(invalidRetention, AxisLearningValidationError);

      const retainedProposalDraft = yield* decodeProposalDraftEffect({
        ...proposalDraft,
        id: "proposal_retention",
        evidenceIds: [retainedEvidence.id],
      });

      const wrongContext = yield* decodeProposalDraftEffect({
        ...retainedProposalDraft,
        id: "proposal_wrong_context",
        contextId: "company_b",
      });
      const validation = yield* Effect.flip(
        store.createProposal(wrongContext, "2026-09-05T10:00:00.000Z"),
      );
      assert.instanceOf(validation, AxisLearningValidationError);

      const proposal = yield* store.createProposal(
        retainedProposalDraft,
        "2026-09-05T10:01:00.000Z",
      );
      yield* store.submitForReview(proposal.id, review("event_submit", "2026-09-05T10:02:00.000Z"));
      const rejected = yield* store.reject(
        proposal.id,
        review("event_reject", "2026-09-05T10:03:00.000Z", "Not appropriate here."),
      );
      assert.equal(rejected.status, "rejected");
      assert.equal((yield* store.getProposal(proposal.id)).reviewNote, "Not appropriate here.");
      const rejectedApproval = yield* Effect.flip(
        store.approve(
          proposal.id,
          AxisLearningVersionId.make("version_rejected"),
          review("event_approve_rejected", "2026-09-05T10:04:00.000Z"),
        ),
      );
      assert.instanceOf(rejectedApproval, AxisLearningTransitionError);

      assert.equal(yield* store.purgeExpiredEvidence("2026-10-05T09:00:59.000Z"), 0);
      assert.equal(yield* store.purgeExpiredEvidence("2026-10-05T09:01:00.000Z"), 2);
      assert.equal((yield* store.listEvidence(retainedEvidence.provenance.contextId)).length, 0);
      assert.equal((yield* store.getProposal(proposal.id)).status, "rejected");
    }),
  );

  it.effect("returns a complete snapshot isolated to one context", () =>
    Effect.gen(function* () {
      const store = yield* AxisLearningStore;
      const companyAEvidence = yield* decodeEvidenceEffect({
        ...evidence,
        id: "evidence_company_a_snapshot",
        provenance: {
          ...evidence.provenance,
          fingerprint: "sha256:company-a-snapshot",
        },
      });
      const companyBEvidence = yield* decodeEvidenceEffect({
        ...evidence,
        id: "evidence_company_b",
        provenance: {
          ...evidence.provenance,
          contextId: "company_b",
          fingerprint: "sha256:company-b",
        },
      });
      const snapshotProposal = yield* decodeProposalDraftEffect({
        ...proposalDraft,
        id: "proposal_snapshot",
        evidenceIds: [companyAEvidence.id],
      });
      yield* store.recordEvidence(companyAEvidence);
      yield* store.recordEvidence(companyBEvidence);
      yield* store.createProposal(snapshotProposal, "2026-09-05T10:00:00.000Z");

      const snapshot = yield* store.getSnapshot(AxisContextId.make("company_a"));
      assert.equal(snapshot.contextId, "company_a");
      assert.isTrue(snapshot.evidence.some((item) => item.id === companyAEvidence.id));
      assert.isFalse(snapshot.evidence.some((item) => item.id === companyBEvidence.id));
      assert.isTrue(snapshot.proposals.some((item) => item.id === snapshotProposal.id));
      assert.isTrue(snapshot.evidence.every((item) => item.provenance.contextId === "company_a"));
      assert.isTrue(snapshot.proposals.every((item) => item.contextId === "company_a"));
      assert.isTrue(snapshot.versions.every((item) => item.contextId === "company_a"));
      assert.isTrue(snapshot.activeVersions.every((item) => item.contextId === "company_a"));
      assert.isTrue(snapshot.lifecycle.every((item) => item.contextId === "company_a"));
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  AxisContextId,
  AxisLearningConflictError,
  AxisLearningEvidence,
  AxisLearningEvidenceId,
  AxisLearningLifecycleEventId,
  AxisLearningNotFoundError,
  AxisLearningScope,
  AxisLearningProposalDraft,
  AxisLearningTransitionError,
  AxisLearningValidationError,
  AxisLearningVersionId,
  CommandId,
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
const projectA = Schema.decodeUnknownSync(AxisLearningScope)({
  contextId: "company_a",
  project: { environmentId: "local", projectId: "a" },
});
const projectB = Schema.decodeUnknownSync(AxisLearningScope)({
  contextId: "company_a",
  project: { environmentId: "local", projectId: "b" },
});
const contextScope = Schema.decodeUnknownSync(AxisLearningScope)({
  contextId: "company_a",
});

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
  change: {
    op: "set-workflow-step",
    step: {
      id: "verify",
      title: "Focused verification",
      instruction: "Run the focused test first.",
      required: true,
      order: 0,
    },
  },
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
          evidence.provenance.contextId,
          AxisLearningVersionId.make("version_1"),
          review("event_premature", "2026-09-05T10:01:00.000Z"),
        ),
      );
      assert.instanceOf(prematureApproval, AxisLearningTransitionError);

      yield* store.submitForReview(
        proposal.id,
        evidence.provenance.contextId,
        review("event_submit_1", "2026-09-05T10:02:00.000Z"),
      );
      const version1 = yield* store.approve(
        proposal.id,
        evidence.provenance.contextId,
        AxisLearningVersionId.make("version_1"),
        review("event_approve_1", "2026-09-05T10:03:00.000Z", "Reviewed by owner."),
      );
      assert.equal(version1.approvedBy, "user:owner");
      assert.isTrue(
        Option.isNone(yield* store.getActive(AxisContextId.make("company_a"), version1.targetKey)),
      );

      const emptyNoop = yield* store.deactivate(
        contextScope,
        version1.targetKey,
        0,
        CommandId.make("command_empty_noop"),
      );
      assert.equal(emptyNoop.lifecycleEvent, null);
      assert.equal(emptyNoop.activeState.revision, 0);
      const concurrentNoopRetries = yield* Effect.all(
        [
          store.deactivate(
            contextScope,
            version1.targetKey,
            0,
            CommandId.make("command_noop_race"),
          ),
          store.deactivate(
            contextScope,
            version1.targetKey,
            0,
            CommandId.make("command_noop_race"),
          ),
        ].map((attempt) => Effect.exit(attempt)),
        { concurrency: "unbounded" },
      );
      assert.equal(concurrentNoopRetries.filter(Exit.isSuccess).length, 2);
      const emptyNoopConflict = yield* Effect.flip(
        store.activate(
          contextScope,
          version1.targetKey,
          version1.id,
          0,
          CommandId.make("command_empty_noop"),
        ),
      );
      assert.instanceOf(emptyNoopConflict, AxisLearningConflictError);

      const activated = yield* store.activate(
        contextScope,
        version1.targetKey,
        version1.id,
        0,
        CommandId.make("command_activate_1"),
      );
      assert.equal(activated.activeState.revision, 1);
      assert.equal(activated.activeState.versionId, version1.id);
      const activationRetry = yield* store.activate(
        contextScope,
        version1.targetKey,
        version1.id,
        0,
        CommandId.make("command_activate_1"),
      );
      assert.equal(activationRetry.lifecycleEvent?.id, activated.lifecycleEvent?.id);
      assert.equal(activationRetry.activeState.revision, 1);

      const secondDraft = yield* decodeProposalDraftEffect({
        ...proposalDraft,
        id: "proposal_2",
        title: "Refine focused verification",
      });
      const proposal2 = yield* store.createProposal(secondDraft, "2026-09-05T11:00:00.000Z");
      yield* store.submitForReview(
        proposal2.id,
        evidence.provenance.contextId,
        review("event_submit_2", "2026-09-05T11:01:00.000Z"),
      );
      const version2 = yield* store.approve(
        proposal2.id,
        evidence.provenance.contextId,
        AxisLearningVersionId.make("version_2"),
        review("event_approve_2", "2026-09-05T11:02:00.000Z"),
      );
      yield* store.activate(
        contextScope,
        version2.targetKey,
        version2.id,
        1,
        CommandId.make("command_activate_2"),
      );
      const commandPayloadConflict = yield* Effect.flip(
        store.activate(
          contextScope,
          version1.targetKey,
          version1.id,
          2,
          CommandId.make("command_activate_2"),
        ),
      );
      assert.instanceOf(commandPayloadConflict, AxisLearningConflictError);
      const staleRevision = yield* Effect.flip(
        store.activate(
          contextScope,
          version1.targetKey,
          version1.id,
          1,
          CommandId.make("command_stale_revision"),
        ),
      );
      assert.instanceOf(staleRevision, AxisLearningConflictError);
      const rolledBack = yield* store.rollback(
        contextScope,
        version1.targetKey,
        version1.id,
        2,
        CommandId.make("command_rollback_1"),
      );
      assert.equal(rolledBack.activeState.versionId, version1.id);
      assert.equal(rolledBack.activeState.revision, 3);
      const deactivated = yield* store.deactivate(
        contextScope,
        version1.targetKey,
        3,
        CommandId.make("command_deactivate_1"),
        "Disable until the next turn.",
      );
      assert.equal(deactivated.activeState.versionId, null);
      assert.equal(deactivated.activeState.revision, 4);
      const deactivateRetry = yield* store.deactivate(
        contextScope,
        version1.targetKey,
        4,
        CommandId.make("command_deactivate_2"),
      );
      assert.equal(deactivateRetry.lifecycleEvent, null);
      assert.equal(deactivateRetry.activeState.revision, 4);
      const deactivateReplay = yield* store.deactivate(
        contextScope,
        version1.targetKey,
        4,
        CommandId.make("command_deactivate_2"),
      );
      const deactivateNoopWithDifferentRequest = yield* Effect.flip(
        store.deactivate(
          contextScope,
          version1.targetKey,
          4,
          CommandId.make("command_deactivate_2"),
          "A different no-op request.",
        ),
      );
      assert.instanceOf(deactivateNoopWithDifferentRequest, AxisLearningConflictError);
      assert.equal(deactivateReplay.lifecycleEvent, null);
      const independentNoop = yield* store.deactivate(
        contextScope,
        version1.targetKey,
        4,
        CommandId.make("command_deactivate_3"),
      );
      assert.equal(independentNoop.lifecycleEvent, null);
      assert.equal(independentNoop.activeState.revision, 4);
      const reactivated = yield* store.activate(
        contextScope,
        version2.targetKey,
        version2.id,
        4,
        CommandId.make("command_reactivate_1"),
      );
      assert.equal(reactivated.activeState.versionId, version2.id);
      assert.equal(reactivated.activeState.revision, 5);
      const reusedNoop = yield* Effect.flip(
        store.activate(
          contextScope,
          version2.targetKey,
          version2.id,
          5,
          CommandId.make("command_deactivate_2"),
        ),
      );
      assert.instanceOf(reusedNoop, AxisLearningConflictError);
      const replayAfterActivation = yield* store.deactivate(
        contextScope,
        version1.targetKey,
        4,
        CommandId.make("command_deactivate_2"),
      );
      assert.equal(replayAfterActivation.lifecycleEvent, null);
      assert.equal(replayAfterActivation.activeState.versionId, version2.id);
      const activationReplayAfterChanges = yield* store.activate(
        contextScope,
        version1.targetKey,
        version1.id,
        0,
        CommandId.make("command_activate_1"),
      );
      assert.equal(activationReplayAfterChanges.lifecycleEvent?.id, activated.lifecycleEvent?.id);
      assert.equal(activationReplayAfterChanges.activeState.versionId, version2.id);
      assert.equal(activationReplayAfterChanges.activeState.revision, 5);

      const lifecycle = yield* store.listLifecycle(evidence.provenance.contextId);
      assert.deepEqual(
        lifecycle.map((event) => event.action).sort(),
        [
          "submitted",
          "approved",
          "submitted",
          "approved",
          "activated",
          "activated",
          "deactivated",
          "rolled-back",
          "activated",
        ].sort(),
      );
      assert.equal(
        lifecycle.find((event) => event.action === "rolled-back")?.previousVersionId,
        version2.id,
      );

      const concurrentActivations = yield* Effect.all(
        [
          store.activate(
            contextScope,
            version1.targetKey,
            version1.id,
            5,
            CommandId.make("command_concurrent_activate_1"),
          ),
          store.activate(
            contextScope,
            version2.targetKey,
            version2.id,
            5,
            CommandId.make("command_concurrent_activate_2"),
          ),
        ].map((attempt) => Effect.exit(attempt)),
        { concurrency: "unbounded" },
      );
      assert.equal(concurrentActivations.filter(Exit.isSuccess).length, 1);
      assert.equal(concurrentActivations.filter(Exit.isFailure).length, 1);
      assert.equal(
        (yield* store.getSnapshot(evidence.provenance.contextId)).activeStates[0]?.revision,
        6,
      );
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
        contextId: AxisContextId.make("company_b"),
      });
      const validation = yield* Effect.flip(
        store.createProposal(wrongContext, "2026-09-05T10:00:00.000Z"),
      );
      assert.instanceOf(validation, AxisLearningValidationError);

      const proposal = yield* store.createProposal(
        retainedProposalDraft,
        "2026-09-05T10:01:00.000Z",
      );
      yield* store.submitForReview(
        proposal.id,
        retainedEvidence.provenance.contextId,
        review("event_submit", "2026-09-05T10:02:00.000Z"),
      );
      const rejected = yield* store.reject(
        proposal.id,
        retainedEvidence.provenance.contextId,
        review("event_reject", "2026-09-05T10:03:00.000Z", "Not appropriate here."),
      );
      assert.equal(rejected.status, "rejected");
      assert.equal((yield* store.getProposal(proposal.id)).reviewNote, "Not appropriate here.");
      const rejectedApproval = yield* Effect.flip(
        store.approve(
          proposal.id,
          retainedEvidence.provenance.contextId,
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

  it.effect("isolates project scopes and returns the canonical semantic replay", () =>
    Effect.gen(function* () {
      const store = yield* AxisLearningStore;
      const scopedEvidenceA = yield* decodeEvidenceEffect({
        ...evidence,
        id: "evidence_project_a",
        provenance: { ...evidence.provenance, scope: projectA, fingerprint: "sha256:shared" },
        createdAt: "2026-09-05T12:00:00.000Z",
        expiresAt: "2026-10-05T12:00:00.000Z",
      });
      const replay = yield* decodeEvidenceEffect({
        ...scopedEvidenceA,
        id: "evidence_project_a_replay",
        createdAt: "2026-09-05T13:00:00.000Z",
        expiresAt: "2026-10-05T13:00:00.000Z",
      });
      const scopedEvidenceB = yield* decodeEvidenceEffect({
        ...scopedEvidenceA,
        id: "evidence_project_b",
        provenance: { ...scopedEvidenceA.provenance, scope: projectB },
      });

      assert.equal((yield* store.recordEvidence(scopedEvidenceA)).id, scopedEvidenceA.id);
      assert.equal((yield* store.recordEvidence(replay)).id, scopedEvidenceA.id);
      yield* store.recordEvidence(scopedEvidenceB);
      assert.equal(
        (yield* store.listEvidence(AxisContextId.make("company_a"), projectA)).length,
        1,
      );
      assert.equal(
        (yield* store.listEvidence(AxisContextId.make("company_a"), projectB)).length,
        1,
      );
      assert.isTrue(
        (yield* store.listEvidence(AxisContextId.make("company_a"))).every(
          (item) => item.provenance.scope === undefined,
        ),
      );

      const wrongScope = yield* decodeProposalDraftEffect({
        ...proposalDraft,
        id: "proposal_wrong_project_scope",
        scope: projectA,
        evidenceIds: [scopedEvidenceB.id],
      });
      const wrongScopeError = yield* Effect.flip(
        store.createProposal(wrongScope, "2026-09-05T14:00:00.000Z"),
      );
      assert.instanceOf(wrongScopeError, AxisLearningValidationError);
    }),
  );

  it.effect("scopes proposal and activation version lookups before decoding", () =>
    Effect.gen(function* () {
      const store = yield* AxisLearningStore;
      const scopedEvidence = yield* decodeEvidenceEffect({
        ...evidence,
        id: "evidence_lookup_scope",
        provenance: { ...evidence.provenance, scope: projectA, fingerprint: "sha256:lookup-scope" },
      });
      const scopedDraft = yield* decodeProposalDraftEffect({
        ...proposalDraft,
        id: "proposal_lookup_scope",
        scope: projectA,
        evidenceIds: [scopedEvidence.id],
      });
      yield* store.recordEvidence(scopedEvidence);
      const proposal = yield* store.createProposal(scopedDraft, "2026-09-05T12:00:00.000Z");

      const proposalOutsideScope = yield* Effect.flip(store.getProposal(proposal.id, projectB));
      assert.instanceOf(proposalOutsideScope, AxisLearningNotFoundError);
      assert.equal((yield* store.getProposal(proposal.id, projectA)).id, proposal.id);

      yield* store.submitForReview(
        proposal.id,
        projectA,
        review("event_lookup_submit", "2026-09-05T12:01:00.000Z"),
      );
      const version = yield* store.approve(
        proposal.id,
        projectA,
        AxisLearningVersionId.make("version_lookup_scope"),
        review("event_lookup_approve", "2026-09-05T12:02:00.000Z"),
      );
      const outsideScopeActivation = yield* Effect.flip(
        store.activate(
          projectB,
          version.targetKey,
          version.id,
          0,
          CommandId.make("command_lookup_outside_scope"),
        ),
      );
      assert.instanceOf(outsideScopeActivation, AxisLearningNotFoundError);
    }),
  );
});

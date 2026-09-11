import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  AxisLearningEvidence,
  AxisLearningLifecycleEvent,
  AxisLearningProposal,
  AxisLearningSnapshot,
  AxisLearningScope,
  AxisLearningVersion,
  AxisProjectProfile,
  AxisTaskExtension,
  AxisContextProjectScope,
} from "@t3tools/contracts";
import {
  AxisProjectDataLifecycleAuthorizationError,
  axisProjectDataLifecyclePolicy,
  AxisProjectDataLifecycleValidationError,
  layer,
} from "./AxisProjectDataLifecycle.ts";
import {
  AxisProjectDataLifecycle,
  type AxisProjectDataLifecycleDataset,
} from "./AxisProjectDataLifecycle.ts";

const decodeScope = Schema.decodeUnknownSync(AxisContextProjectScope);
const decodeLearningScope = Schema.decodeUnknownSync(AxisLearningScope);
const decodeEvidence = Schema.decodeUnknownSync(AxisLearningEvidence);
const decodeLifecycle = Schema.decodeUnknownSync(AxisLearningLifecycleEvent);
const decodeProposal = Schema.decodeUnknownSync(AxisLearningProposal);
const decodeSnapshot = Schema.decodeUnknownSync(AxisLearningSnapshot);
const decodeProfile = Schema.decodeUnknownSync(AxisProjectProfile);
const decodeTask = Schema.decodeUnknownSync(AxisTaskExtension);
const decodeVersion = Schema.decodeUnknownSync(AxisLearningVersion);

const scopeA = decodeScope({
  contextId: "company_a",
  project: { environmentId: "local", projectId: "project-a" },
});
const scopeB = decodeScope({
  contextId: "company_a",
  project: { environmentId: "local", projectId: "project-b" },
});
const scopeOtherContext = decodeScope({
  contextId: "company_b",
  project: { environmentId: "local", projectId: "project-a" },
});

const evidence = (id: string, expiresAt: string, scope = scopeA) =>
  decodeEvidence({
    id,
    provenance: {
      contextId: scope.contextId,
      scope: decodeLearningScope(scope),
      sourceKind: "thread-turn",
      sourceId: `thread:${id}`,
      observedAt: "2026-09-09T09:00:00.000Z",
      fingerprint: `sha256:${id}`,
    },
    summary: `Evidence ${id}`,
    createdAt: "2026-09-09T09:01:00.000Z",
    expiresAt,
  });

const learning = (projectEvidence: ReadonlyArray<ReturnType<typeof evidence>>) =>
  decodeSnapshot({
    contextId: "company_a",
    evidence: projectEvidence,
    proposals: [],
    versions: [],
    activeVersions: [],
    activeStates: [],
    lifecycle: [],
  });

const profile = (scope: typeof scopeA) =>
  decodeProfile({
    scope,
    revision: 1,
    sources: [],
    facts: [],
    rules: [],
    manualDecisions: [],
    workflow: [],
    tokenEfficiencyPolicies: [],
    updatedAt: "2026-09-09T09:00:00.000Z",
  });

const immutableEvidence = evidence("retained-evidence", "2026-09-11T09:00:00.000Z");
const immutableProposal = decodeProposal({
  id: "proposal-retained",
  contextId: "company_a",
  scope: decodeLearningScope(scopeA),
  kind: "workflow-recommendation",
  targetKey: "workflow:verify",
  title: "Retained workflow",
  rationale: "The approved history must remain auditable.",
  evidenceIds: [immutableEvidence.id],
  change: {
    op: "set-workflow-step",
    step: {
      id: "verify",
      title: "Verify",
      instruction: "Run the focused test.",
      required: true,
      order: 0,
    },
  },
  status: "approved",
  createdAt: "2026-09-09T09:00:00.000Z",
  updatedAt: "2026-09-09T09:01:00.000Z",
  reviewedAt: "2026-09-09T09:01:00.000Z",
  reviewedBy: "user:owner",
  reviewNote: null,
});
const immutableVersion = decodeVersion({
  id: "version-retained",
  proposalId: immutableProposal.id,
  contextId: "company_a",
  scope: decodeLearningScope(scopeA),
  kind: immutableProposal.kind,
  targetKey: immutableProposal.targetKey,
  title: immutableProposal.title,
  rationale: immutableProposal.rationale,
  evidenceIds: immutableProposal.evidenceIds,
  change: immutableProposal.change,
  status: "approved",
  approvedBy: "user:owner",
  createdAt: "2026-09-09T09:02:00.000Z",
});
const immutableLifecycle = decodeLifecycle({
  id: "lifecycle-retained",
  contextId: "company_a",
  scope: decodeLearningScope(scopeA),
  action: "approved",
  proposalId: immutableProposal.id,
  versionId: immutableVersion.id,
  previousVersionId: null,
  actor: "user:owner",
  note: null,
  createdAt: "2026-09-09T09:02:00.000Z",
});

const task = (scope: typeof scopeA, id: string) =>
  decodeTask({
    id,
    scope,
    threadId: `thread-${id}`,
    title: `Task ${id}`,
    status: "active",
    acceptanceCriteria: [],
    workflowVersion: "workflow-v1",
    steps: [],
    createdAt: "2026-09-09T09:00:00.000Z",
    updatedAt: "2026-09-09T09:00:00.000Z",
    revision: 0,
  });

const dataset = (overrides: Partial<AxisProjectDataLifecycleDataset> = {}) => ({
  profile: profile(scopeA),
  learning: learning([evidence("expired", "2026-09-10T09:00:00.000Z")]),
  tasks: [task(scopeA, "task-a"), task(scopeB, "task-b")],
  taskCommands: [
    {
      contextId: "company_a",
      scope: scopeA,
      threadId: "thread-task-a",
      commandId: "command-a",
      taskId: "task-a",
      requestDigest: "sha256:command-a",
      createdAt: "2026-09-09T09:00:00.000Z",
    },
    {
      contextId: "company_a",
      scope: scopeB,
      threadId: "thread-task-b",
      commandId: "command-b",
      taskId: "task-b",
      requestDigest: "sha256:command-b",
      createdAt: "2026-09-09T09:00:00.000Z",
    },
  ],
  taskLifecycle: [],
  ...overrides,
});

const testLayer = it.layer(layer);

testLayer("AxisProjectDataLifecycle", (it) => {
  it.effect("exports the exact scope and marks expired evidence unavailable", () =>
    Effect.gen(function* () {
      const lifecycle = yield* AxisProjectDataLifecycle;
      const authorization = yield* lifecycle.authorize({ action: "export", scope: scopeA });
      const input = dataset();
      const exported = yield* lifecycle.export(authorization, input, "2026-09-10T10:00:00.000Z");
      const exportedEvidence = exported.learning.evidence[0];

      assert.equal(exported.scope.project.projectId, "project-a");
      assert.deepEqual(
        exported.tasks.map((item) => String(item.id)),
        ["task-a"],
      );
      assert.deepEqual(
        exported.taskCommands.map((item) => item.commandId),
        ["command-a"],
      );
      assert.equal(exportedEvidence?.availability, "unavailable");
      if (exportedEvidence?.availability === "unavailable") {
        assert.equal(exportedEvidence.reason, "expired");
      }
      assert.equal(exported.learning.evidenceReferences[0]?.availability, "unavailable");
      assert.equal(exportedEvidence !== undefined && "evidence" in exportedEvidence, false);
      assert.equal(Object.isFrozen(exported), true);
      assert.equal(Object.isFrozen(exported.learning), true);
      assert.equal(input.tasks?.length, 2);
      assert.equal(input.learning.evidence[0]?.summary, "Evidence expired");
    }),
  );

  it.effect("purges only expired evidence in the authorized scope", () =>
    Effect.gen(function* () {
      const lifecycle = yield* AxisProjectDataLifecycle;
      const authorization = yield* lifecycle.authorize({ action: "purge", scope: scopeA });
      const result = yield* lifecycle.purge(
        authorization,
        dataset({
          learning: learning([
            evidence("expired-a", "2026-09-10T09:00:00.000Z"),
            evidence("live-a", "2026-09-11T09:00:00.000Z"),
            evidence("expired-b", "2026-09-10T09:00:00.000Z", scopeB),
          ]),
        }),
        "2026-09-10T10:00:00.000Z",
      );

      assert.deepEqual(result.evidenceIds.map(String), ["expired-a"]);
      assert.equal(result.retainedEvidenceReferences[0]?.availability, "unavailable");
      assert.equal(result.scope.project.projectId, "project-a");
    }),
  );

  it.effect("deletes mutable project data while retaining immutable learning history", () =>
    Effect.gen(function* () {
      const lifecycle = yield* AxisProjectDataLifecycle;
      const authorization = yield* lifecycle.authorize({ action: "delete", scope: scopeA });
      const result = yield* lifecycle.delete(authorization, dataset());

      assert.equal(result.mutable.deleteProfile, true);
      assert.deepEqual(result.mutable.taskIds.map(String), ["task-a"]);
      assert.deepEqual(result.mutable.taskCommandIds, ["command-a"]);
      assert.deepEqual(result.mutable.evidenceIds.map(String), ["expired"]);
      assert.deepEqual(result.retained.versionIds, []);
      assert.deepEqual(result.retained.lifecycleIds, []);
      assert.match(result.retained.reason, /immutable/);
    }),
  );

  it.effect("retains version history and its proposal dependency during project delete", () =>
    Effect.gen(function* () {
      const lifecycle = yield* AxisProjectDataLifecycle;
      const authorization = yield* lifecycle.authorize({ action: "delete", scope: scopeA });
      const result = yield* lifecycle.delete(
        authorization,
        dataset({
          learning: decodeSnapshot({
            ...learning([immutableEvidence]),
            proposals: [immutableProposal],
            versions: [immutableVersion],
            lifecycle: [immutableLifecycle],
          }),
        }),
      );

      assert.deepEqual(result.mutable.proposalIds, []);
      assert.deepEqual(result.retained.proposalIds, [immutableProposal.id]);
      assert.deepEqual(result.retained.versionIds, [immutableVersion.id]);
      assert.deepEqual(result.retained.lifecycleIds, [immutableLifecycle.id]);
    }),
  );

  it.effect("rejects cross-scope policy use and keeps promotion clearly unavailable", () =>
    Effect.gen(function* () {
      const lifecycle = yield* AxisProjectDataLifecycle;
      const policy = axisProjectDataLifecyclePolicy(scopeA, ["export"]);
      const mismatch = yield* lifecycle
        .authorize({ action: "export", scope: scopeOtherContext, policy })
        .pipe(Effect.flip);
      assert.instanceOf(mismatch, AxisProjectDataLifecycleAuthorizationError);
      assert.equal(mismatch.reason, "scope_mismatch");

      const promotion = yield* lifecycle
        .authorize({ action: "promote", scope: scopeA, policy })
        .pipe(Effect.flip);
      assert.instanceOf(promotion, AxisProjectDataLifecycleAuthorizationError);
      assert.equal(promotion.reason, "promotion_unavailable");

      const forbidden = yield* lifecycle
        .authorize({ action: "delete", scope: scopeA, policy })
        .pipe(Effect.flip);
      assert.equal(forbidden.reason, "action_not_allowed");
    }),
  );

  it.effect("does not accept a learning snapshot from another context", () =>
    Effect.gen(function* () {
      const lifecycle = yield* AxisProjectDataLifecycle;
      const authorization = yield* lifecycle.authorize({ action: "export", scope: scopeA });
      const error = yield* lifecycle
        .export(
          authorization,
          dataset({ learning: decodeSnapshot({ ...learning([]), contextId: "company_b" }) }),
          "2026-09-10T10:00:00.000Z",
        )
        .pipe(Effect.flip);
      assert.instanceOf(error, AxisProjectDataLifecycleValidationError);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import {
  AxisContextProjectScope,
  AxisLearningEvidence,
  AxisTaskExtension,
  CommandId,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { AxisTaskStore } from "../tasks/AxisTaskStore.ts";
import { type WorkflowRequest } from "../tasks/AxisTaskWorkflow.ts";
import { AxisTaskWorkflowStore } from "../tasks/AxisTaskWorkflowStore.ts";
import { AxisLearningOutcomes, make } from "./AxisLearningOutcomes.ts";
import { AxisLearningStore } from "./AxisLearningStore.ts";
import { AxisTaskFeedbackService } from "./AxisTaskFeedbackService.ts";

const scope = Schema.decodeUnknownSync(AxisContextProjectScope)({
  contextId: "company",
  project: { environmentId: "env", projectId: "project" },
});
const task = Schema.decodeUnknownSync(AxisTaskExtension)({
  id: "task_1",
  scope,
  threadId: "task_thread",
  title: "Improve the parser",
  acceptanceCriteria: [],
  workflowVersion: "workflow-1",
  steps: [
    {
      id: "implement",
      skillId: "implement",
      status: "completed",
      turnId: "turn_1",
      commandId: "command_1",
      reason: null,
      startedAt: "2026-09-11T10:00:00.000Z",
      finishedAt: "2026-09-11T10:01:00.000Z",
    },
  ],
  status: "active",
  revision: 1,
  createdAt: "2026-09-11T09:59:00.000Z",
  updatedAt: "2026-09-11T10:01:00.000Z",
});
const request: WorkflowRequest = {
  task,
  stepId: task.steps[0]!.id,
  commandId: CommandId.make("command_1"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
};
const canonical = Schema.decodeUnknownSync(AxisLearningEvidence)({
  id: "canonical_task_feedback",
  provenance: {
    contextId: scope.contextId,
    scope,
    sourceKind: "thread-turn",
    sourceId: "axis-task:task_1:thread:attempt:turn:turn_1:outcome:completed",
    provider: { environmentId: "env", instanceId: "codex" },
    observedAt: "2026-09-11T10:01:00.000Z",
    fingerprint: "sha256:canonical",
  },
  summary: "Task execution completed.",
  createdAt: "2026-09-11T10:02:00.000Z",
  expiresAt: "2026-10-11T10:02:00.000Z",
});

let runtimePayload: unknown = {
  axisLearningVersionIds: ["learning_version_1", "learning_version_2"],
};
const persisted = new Map<string, AxisLearningEvidence>();

const dependencies = Layer.mergeAll(
  SqlitePersistenceMemory,
  Layer.mock(AxisTaskStore)({
    get: () => Effect.succeed(Option.some(task)),
    list: () => Effect.succeed([task]),
    create: () => Effect.die("not used"),
    update: () => Effect.die("not used"),
    pause: () => Effect.die("not used"),
    reopen: () => Effect.die("not used"),
    unlinkSource: () => Effect.die("not used"),
    listLifecycle: () => Effect.succeed([]),
  }),
  Layer.mock(AxisTaskWorkflowStore)({
    get: () => Effect.succeed(Option.some(request)),
    admit: () => Effect.die("not used"),
    retry: () => Effect.die("not used"),
    settle: () => Effect.die("not used"),
  }),
  Layer.mock(AxisTaskFeedbackService)({ record: () => Effect.succeed(canonical) }),
  Layer.mock(ProviderSessionDirectory)({
    upsert: () => Effect.void,
    getProvider: () => Effect.succeed(ProviderDriverKind.make("codex")),
    getBinding: () =>
      Effect.succeed(
        Option.some({
          threadId: ThreadId.make("attempt"),
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimePayload,
        }),
      ),
    listThreadIds: () => Effect.succeed([]),
    listBindings: () => Effect.succeed([]),
  }),
  Layer.mock(AxisLearningStore)({
    recordEvidence: (evidence) =>
      Effect.sync(() => {
        const prior = persisted.get(evidence.provenance.fingerprint);
        if (prior !== undefined) return prior;
        persisted.set(evidence.provenance.fingerprint, evidence);
        return evidence;
      }),
    listEvidence: () => Effect.sync(() => [...persisted.values()]),
    purgeExpiredEvidence: () => Effect.succeed(0),
    createProposal: () => Effect.die("not used"),
    getProposal: () => Effect.die("not used"),
    submitForReview: () => Effect.die("not used"),
    approve: () => Effect.die("not used"),
    reject: () => Effect.die("not used"),
    activate: () => Effect.die("not used"),
    rollback: () => Effect.die("not used"),
    deactivate: () => Effect.die("not used"),
    getActive: () => Effect.succeed(Option.none()),
    listLifecycle: () => Effect.succeed([]),
    getSnapshot: () => Effect.die("not used"),
  }),
);

const outcomesLayer = Layer.effect(AxisLearningOutcomes, make).pipe(Layer.provide(dependencies));
const layer = it.layer(outcomesLayer);

const input = {
  scope,
  threadId: task.threadId,
  taskId: task.id,
  stepId: task.steps[0]!.id,
  commandId: request.commandId,
  expectedTurnId: TurnId.make("turn_1"),
};
const caller = { environmentId: EnvironmentId.make("env"), contextId: scope.contextId };

layer("AxisLearningOutcomes", (it) => {
  it.effect("records one idempotent outcome per Learning version actually used", () =>
    Effect.gen(function* () {
      persisted.clear();
      runtimePayload = { axisLearningVersionIds: ["learning_version_1", "learning_version_2"] };
      const service = yield* AxisLearningOutcomes;
      const first = yield* service.record(caller, input);
      const second = yield* service.record(caller, input);

      assert.deepEqual(
        first.outcomes.map(({ provenance }) => provenance.cursor),
        ["learning_version_1", "learning_version_2"],
      );
      assert.deepEqual(
        second.outcomes.map(({ id }) => id),
        first.outcomes.map(({ id }) => id),
      );
      assert.equal(persisted.size, 2);
      assert.match(first.outcomes[0]!.summary, /not proof/);
    }),
  );

  it.effect("reconciles durable task metadata when outcomes are read after restart", () =>
    Effect.gen(function* () {
      persisted.clear();
      runtimePayload = { axisLearningVersionIds: [] };
      const service = yield* AxisLearningOutcomes;
      const outcomes = yield* service.list(scope);

      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]!.provenance.cursor, "none");
      assert.match(outcomes[0]!.summary, /no learned version was active/);
    }),
  );
});

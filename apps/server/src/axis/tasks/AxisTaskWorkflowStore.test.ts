import { assert, it } from "@effect/vitest";
import {
  AxisTaskConflictError,
  CommandId,
  EnvironmentId,
  ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { AxisTaskExtension } from "@t3tools/contracts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import Migration059 from "../../persistence/Migrations/059_AxisProjectWork.ts";
import Migration061 from "../../persistence/Migrations/061_AxisTaskCommands.ts";
import Migration065 from "../../persistence/Migrations/065_AxisWorkflowAttempts.ts";
import { AxisTaskStore, layer as taskLayer } from "./AxisTaskStore.ts";
import { AxisTaskWorkflowStore, make, layer as workflowLayer } from "./AxisTaskWorkflowStore.ts";
import { attemptThreadId, type WorkflowRequest, type WorkflowState } from "./AxisTaskWorkflow.ts";

const migration = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Migration059;
    yield* Migration061;
    yield* Migration065;
  }),
);
const db = migration.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));
const deps = Layer.mergeAll(
  db,
  Layer.mock(ServerEnvironmentIdentity)({
    getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
  }),
  Layer.mock(ProjectionSnapshotQuery)({
    getThreadShellById: (id) => Effect.succeed(Option.some({ id, projectId: "project" } as never)),
  }),
);
const taskDeps = taskLayer.pipe(Layer.provideMerge(deps));
const all = workflowLayer.pipe(Layer.provideMerge(taskDeps));
const decodeTask = Schema.decodeUnknownSync(AxisTaskExtension);
const taskFor = (id: string) =>
  decodeTask({
    id,
    scope: { contextId: "company", project: { environmentId: "env", projectId: "project" } },
    threadId: `thread-${id}`,
    title: "Analyze a scoped task",
    acceptanceCriteria: [{ id: "goal", text: "Explain the change" }],
    workflowVersion: "1",
    steps: [
      {
        id: "intake",
        skillId: "intake",
        status: "not-executed",
        turnId: null,
        commandId: null,
        reason: null,
        startedAt: null,
        finishedAt: null,
      },
    ],
    status: "active",
    revision: 0,
    createdAt: "2026-09-10T12:00:00.000Z",
    updatedAt: "2026-09-10T12:00:00.000Z",
  });
const modelSelection = Schema.decodeUnknownSync(ModelSelection)({
  instanceId: "codex",
  model: "gpt-5.6-luna",
});
const failedState = (request: WorkflowRequest): WorkflowState => ({
  taskId: request.task.id,
  stepId: request.stepId,
  status: "failed",
  reason: "Observed provider failure",
  artifact: null,
  execution: { threadId: attemptThreadId(request), commandId: request.commandId, turnId: null },
});

it.layer(all)("AxisTaskWorkflowStore", (it) => {
  it.effect(
    "preflight refusal leaves metadata and command free; admitted replay never runs preflight again",
    () =>
      Effect.gen(function* () {
        const tasks = yield* AxisTaskStore;
        const store = yield* AxisTaskWorkflowStore;
        const task = yield* tasks.create(taskFor("preflight"), CommandId.make("create-preflight"));
        const input = {
          scope: task.scope,
          taskId: task.id,
          threadId: task.threadId,
          stepId: task.steps[0]!.id,
          expectedRevision: task.revision,
          commandId: CommandId.make("preflight-command"),
          modelSelection,
        };
        let prepared = 0;
        const refused = yield* store.admit(input, (request) =>
          Effect.sync(() => {
            prepared++;
            return {
              ...failedState(request),
              status: "blocked" as const,
              reason: "Missing canonical prerequisite",
            };
          }),
        );
        assert.equal(refused.created, false);
        assert.equal(refused.blocked?.status, "blocked");
        assert.equal(
          Option.isNone(yield* store.get(task.scope, task.threadId, input.commandId)),
          true,
        );
        assert.deepEqual(Option.getOrThrow(yield* tasks.get(task.scope, task.threadId)), task);
        const admitted = yield* store.admit(input, () =>
          Effect.sync(() => {
            prepared++;
            return null;
          }),
        );
        assert.equal(admitted.created, true);
        const replay = yield* store.admit(input, () => Effect.die("Replay must not run preflight"));
        assert.equal(replay.created, false);
        assert.equal(prepared, 2);
      }),
  );
  it.effect("retry CAS admits one new command and late old settlement cannot overwrite it", () =>
    Effect.gen(function* () {
      const tasks = yield* AxisTaskStore;
      const store = yield* AxisTaskWorkflowStore;
      const task = yield* tasks.create(taskFor("retry-cas"), CommandId.make("create-retry-cas"));
      const input = {
        scope: task.scope,
        taskId: task.id,
        threadId: task.threadId,
        stepId: task.steps[0]!.id,
        expectedRevision: task.revision,
        commandId: CommandId.make("initial-retry-cas"),
        modelSelection,
      };
      const first = yield* store.admit(input);
      const observed = failedState(first.request);
      yield* store.settle(first.request, observed);
      const failed = Option.getOrThrow(yield* tasks.get(task.scope, task.threadId));
      const retry = {
        ...input,
        commandId: CommandId.make("second-retry-cas"),
        previousCommandId: input.commandId,
        expectedRevision: failed.revision,
      };
      assert.equal(
        (yield* Effect.flip(
          store.retry({ ...retry, expectedRevision: retry.expectedRevision - 1 }, observed),
        ))._tag,
        "AxisTaskConflictError",
      );
      assert.equal(
        Option.isNone(yield* store.get(task.scope, task.threadId, retry.commandId)),
        true,
      );
      const next = yield* store.retry(retry, observed);
      assert.equal(next.created, true);
      assert.equal(next.request.task.steps[0]?.commandId, null);
      assert.equal(next.request.task.steps[0]?.status, "not-executed");
      assert.notEqual(attemptThreadId(next.request), attemptThreadId(first.request));
      const current = Option.getOrThrow(yield* tasks.get(task.scope, task.threadId));
      assert.equal(
        yield* store.settle(first.request, { ...observed, reason: "Late stale error" }),
        false,
      );
      assert.deepEqual(Option.getOrThrow(yield* tasks.get(task.scope, task.threadId)), current);
      assert.deepEqual(yield* store.retry(retry, observed), { ...next, created: false });
      assert.equal(
        (yield* Effect.flip(
          store.retry(
            {
              ...retry,
              commandId: CommandId.make("competing-retry"),
              expectedRevision: current.revision,
            },
            observed,
          ),
        ))._tag,
        "AxisTaskValidationError",
      );
    }),
  );
  it.effect("settlement requires an immutable request and a matching artifact for completion", () =>
    Effect.gen(function* () {
      const tasks = yield* AxisTaskStore;
      const store = yield* AxisTaskWorkflowStore;
      const task = yield* tasks.create(taskFor("settlement"), CommandId.make("create-settlement"));
      const admission = yield* store.admit({
        scope: task.scope,
        taskId: task.id,
        threadId: task.threadId,
        stepId: task.steps[0]!.id,
        expectedRevision: task.revision,
        commandId: CommandId.make("settlement-command"),
        modelSelection,
      });
      const observed = failedState(admission.request);
      assert.equal(
        (yield* Effect.flip(store.settle(admission.request, { ...observed, status: "completed" })))
          ._tag,
        "AxisTaskValidationError",
      );
      assert.equal(
        (yield* Effect.flip(
          store.settle(
            {
              ...admission.request,
              task: { ...admission.request.task, title: "Changed snapshot" },
            },
            observed,
          ),
        ))._tag,
        "AxisTaskValidationError",
      );
      assert.equal(
        (yield* Effect.flip(
          store.retry(
            {
              scope: task.scope,
              taskId: task.id,
              threadId: task.threadId,
              stepId: task.steps[0]!.id,
              expectedRevision: task.revision + 1,
              commandId: CommandId.make("unknown-retry"),
              previousCommandId: admission.request.commandId,
              modelSelection,
            },
            { ...observed, status: "unknown" },
          ),
        ))._tag,
        "AxisTaskValidationError",
      );
      const current = Option.getOrThrow(yield* tasks.get(task.scope, task.threadId));
      assert.equal(current.steps[0]?.status, "not-executed");
      yield* store.settle(admission.request, observed);
      assert.equal(
        yield* store.settle(admission.request, { ...observed, status: "running", reason: null }),
        false,
      );
      assert.equal(
        Option.getOrThrow(yield* tasks.get(task.scope, task.threadId)).steps[0]?.status,
        "failed",
      );
    }),
  );
  it.effect("rolls back a retry admission when metadata CAS loses", () =>
    Effect.gen(function* () {
      const tasks = yield* AxisTaskStore;
      const store = yield* AxisTaskWorkflowStore;
      const task = yield* tasks.create(
        taskFor("retry-rollback"),
        CommandId.make("create-retry-rollback"),
      );
      const input = {
        scope: task.scope,
        taskId: task.id,
        threadId: task.threadId,
        stepId: task.steps[0]!.id,
        expectedRevision: task.revision,
        commandId: CommandId.make("before-rollback"),
        modelSelection,
      };
      const first = yield* store.admit(input);
      const current = Option.getOrThrow(yield* tasks.get(task.scope, task.threadId));
      const losing = yield* make.pipe(
        Effect.provideService(AxisTaskStore, {
          ...tasks,
          update: () => Effect.fail(new AxisTaskConflictError({ taskId: task.id })),
        }),
      );
      const retry = {
        ...input,
        expectedRevision: current.revision,
        commandId: CommandId.make("rolled-back-retry"),
        previousCommandId: input.commandId,
      };
      assert.equal(
        (yield* Effect.flip(losing.retry(retry, failedState(first.request))))._tag,
        "AxisTaskConflictError",
      );
      assert.equal(
        Option.isNone(yield* store.get(task.scope, task.threadId, retry.commandId)),
        true,
      );
      assert.deepEqual(Option.getOrThrow(yield* tasks.get(task.scope, task.threadId)), current);
    }),
  );
  it.effect("rolls back admission when the task revision write fails", () =>
    Effect.gen(function* () {
      const tasks = yield* AxisTaskStore;
      const task = yield* tasks.create(taskFor("rollback"), CommandId.make("create-rollback"));
      const workflow = yield* make.pipe(
        Effect.provideService(AxisTaskStore, {
          ...tasks,
          update: () => Effect.fail(new AxisTaskConflictError({ taskId: task.id })),
        }),
      );
      const commandId = CommandId.make("run-rollback");
      assert.equal(
        (yield* Effect.flip(
          workflow.admit({
            scope: task.scope,
            taskId: task.id,
            threadId: task.threadId,
            stepId: task.steps[0]!.id,
            expectedRevision: task.revision,
            commandId,
            modelSelection,
          }),
        ))._tag,
        "AxisTaskConflictError",
      );
      assert.equal(Option.isNone(yield* workflow.get(task.scope, task.threadId, commandId)), true);
      assert.deepEqual(Option.getOrThrow(yield* tasks.get(task.scope, task.threadId)), task);
    }),
  );
  it.effect(
    "admits once, persists canonical inputs, and recovers without creating a second attempt",
    () =>
      Effect.gen(function* () {
        const tasks = yield* AxisTaskStore;
        const workflow = yield* AxisTaskWorkflowStore;
        const initial = taskFor("admission");
        const task = yield* tasks.create(initial, CommandId.make("create-admission"));
        const input = {
          scope: task.scope,
          taskId: task.id,
          threadId: task.threadId,
          stepId: task.steps[0]!.id,
          expectedRevision: task.revision,
          commandId: CommandId.make("run-admission"),
          modelSelection,
        };
        const first = yield* workflow.admit(input);
        assert.equal(first.created, true);
        assert.deepEqual(first.request.task, task);
        const current = Option.getOrThrow(yield* tasks.get(task.scope, task.threadId));
        assert.equal(current.revision, task.revision + 1);
        assert.equal(current.steps[0]?.commandId, input.commandId);
        assert.equal(current.steps[0]?.status, "not-executed");
        const recreated = yield* make;
        assert.deepEqual(yield* recreated.admit(input), { ...first, created: false });
        assert.deepEqual(
          Option.getOrThrow(yield* recreated.get(task.scope, task.threadId, input.commandId)),
          first.request,
        );
        const changed = yield* Effect.flip(
          recreated.admit({ ...input, modelSelection: { ...modelSelection, model: "another" } }),
        );
        assert.equal(changed._tag, "AxisTaskCommandConflictError");
        const duplicate = yield* Effect.flip(
          recreated.admit({
            ...input,
            commandId: CommandId.make("second-attempt"),
            expectedRevision: current.revision,
          }),
        );
        assert.equal(duplicate._tag, "AxisTaskValidationError");
      }),
  );
  it.effect(
    "rejects stale admission without leaving a durable attempt and isolates project reads",
    () =>
      Effect.gen(function* () {
        const tasks = yield* AxisTaskStore;
        const workflow = yield* AxisTaskWorkflowStore;
        const task = yield* tasks.create(taskFor("stale"), CommandId.make("create-stale"));
        const input = {
          scope: task.scope,
          taskId: task.id,
          threadId: task.threadId,
          stepId: task.steps[0]!.id,
          expectedRevision: task.revision + 1,
          commandId: CommandId.make("run-stale"),
          modelSelection,
        };
        assert.equal((yield* Effect.flip(workflow.admit(input)))._tag, "AxisTaskConflictError");
        assert.equal(
          Option.isNone(yield* workflow.get(task.scope, task.threadId, input.commandId)),
          true,
        );
        yield* workflow.admit({ ...input, expectedRevision: task.revision });
        const other = taskFor("other");
        assert.equal(
          Option.isNone(yield* workflow.get(other.scope, other.threadId, input.commandId)),
          true,
        );
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM axis_workflow_attempts WHERE task_id = ${task.id}`;
        assert.equal(rows[0]?.count, 1);
      }),
  );
});

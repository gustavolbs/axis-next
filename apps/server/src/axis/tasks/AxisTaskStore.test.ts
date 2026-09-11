import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";

import {
  AxisContextProjectScope,
  axisProjectScopeKey,
} from "../../../../../packages/contracts/src/axisProjectProfile.ts";
import {
  AxisTaskExtension,
  AxisTaskPersistenceError,
  AxisTaskValidationError,
} from "../../../../../packages/contracts/src/axisTask.ts";
import { CommandId, EnvironmentId, ThreadId } from "../../../../../packages/contracts/src/baseSchemas.ts";
import Migration0059 from "../../persistence/Migrations/059_AxisProjectWork.ts";
import Migration0061 from "../../persistence/Migrations/061_AxisTaskCommands.ts";
import {
  AxisTaskCommandConflictError,
  AxisTaskConflictError,
  AxisTaskStore,
  layer as storeLayer,
} from "./AxisTaskStore.ts";

const schema = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Migration0059;
    yield* Migration0061;
  }),
);
const persistence = Layer.provideMerge(schema, NodeSqliteClient.layerMemory());
const projection = Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
  getThreadShellById: (threadId) =>
    Effect.succeed(
      threadId === "thread_missing"
        ? Option.none()
        : Option.some(
            {
              id: threadId,
              projectId: threadId === "thread_wrong_project" ? "different-project" : "project",
            } as never,
          ),
    ),
});
const environment = Layer.mock(ServerEnvironment.ServerEnvironmentIdentity)({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
});
const storeDependencies = Layer.merge(Layer.merge(persistence, projection), environment);
const dependencies = Layer.merge(
  storeDependencies,
  storeLayer.pipe(Layer.provide(storeDependencies)),
);
const layer = it.layer(dependencies);
const decodeScope = Schema.decodeUnknownSync(AxisContextProjectScope);
const decodeTask = Schema.decodeUnknownSync(AxisTaskExtension);
const decodeTaskJson = Schema.decodeUnknownSync(Schema.fromJsonString(AxisTaskExtension));
const encodeTaskJson = Schema.encodeSync(Schema.fromJsonString(AxisTaskExtension));
const TaskEventSchema = Schema.Struct({
  action: Schema.Literals(["created", "updated", "paused", "reopened", "source-unlinked"]),
  task: AxisTaskExtension,
  createdAt: Schema.String,
});
const decodeEvent = Schema.decodeUnknownSync(TaskEventSchema);
const decodeEventJson = Schema.decodeUnknownSync(Schema.fromJsonString(TaskEventSchema));
const encodeEventJson = Schema.encodeSync(Schema.fromJsonString(TaskEventSchema));
const scope = decodeScope({
  contextId: "company",
  project: { environmentId: "env", projectId: "project" },
});
const task = decodeTask({
  id: "task_1",
  scope,
  threadId: "thread_1",
  source: { kind: "jira", issueKey: "AX-1" },
  title: "Verify the project",
  acceptanceCriteria: [{ id: "step_1", text: "Focused tests pass." }],
  workflowVersion: "v1",
  steps: [
    {
      id: "step_1",
      skillId: "verify",
      status: "not-executed",
      turnId: null,
      commandId: null,
      reason: null,
      startedAt: null,
      finishedAt: null,
    },
  ],
  revision: 0,
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
});
const command = (id: string) => CommandId.make(id);

layer("AxisTaskStore", (it) => {
  it.effect("keeps metadata scoped and makes create retry idempotent", () =>
    Effect.gen(function* () {
      const store = yield* AxisTaskStore;
      const sql = yield* SqlClient.SqlClient;
      const created = yield* store.create(task, command("command_create_1"));
      const retry = yield* store.create(task, command("command_create_1"));
      assert.equal(retry.id, created.id);
      const conflict = yield* Effect.flip(
        store.create({ ...task, title: "Different" }, command("command_create_1")),
      );
      assert.instanceOf(conflict, AxisTaskCommandConflictError);
      assert.equal(Option.getOrThrow(yield* store.get(scope, task.threadId)).title, task.title);

      const duplicate = yield* Effect.flip(
        store.create(decodeTask({ ...task, id: "task_duplicate" }), command("command_create_2")),
      );
      assert.instanceOf(duplicate, AxisTaskConflictError);

      const [row] = yield* sql<{ readonly revision: number; readonly taskJson: string }>`
        SELECT revision, task_json AS "taskJson"
        FROM axis_task_extensions
        WHERE context_id = ${scope.contextId} AND thread_id = ${task.threadId}
      `;
      assert.equal(row?.revision, created.revision);
      assert.equal(decodeTaskJson(row?.taskJson ?? "").revision, row?.revision);
      const counts = yield* sql<{
        readonly tasks: number;
        readonly commands: number;
        readonly lifecycle: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM axis_task_extensions) AS tasks,
          (SELECT COUNT(*) FROM axis_task_commands) AS commands,
          (SELECT COUNT(*) FROM axis_task_lifecycle_events) AS lifecycle
      `;
      assert.deepEqual(counts[0], { tasks: 1, commands: 1, lifecycle: 1 });

      const mismatchedJson = encodeTaskJson({ ...task, revision: 1 });
      yield* sql`
        UPDATE axis_task_extensions
        SET task_json = ${mismatchedJson}
        WHERE context_id = ${scope.contextId} AND thread_id = ${task.threadId}
      `;
      const revisionMismatch = yield* Effect.flip(store.get(scope, task.threadId));
      assert.instanceOf(revisionMismatch, AxisTaskPersistenceError);
    }),
  );

  it.effect("rejects task rows whose physical identity differs from task JSON", () =>
    Effect.gen(function* () {
      const store = yield* AxisTaskStore;
      const sql = yield* SqlClient.SqlClient;
      const storedTask = decodeTask({ ...task, id: "task_identity", threadId: "thread_identity" });
      yield* store.create(storedTask, command("command_identity_create"));

      const restorePhysicalIdentity = () => sql`
        UPDATE axis_task_extensions
        SET context_id = ${scope.contextId}, environment_id = ${scope.project.environmentId},
            project_id = ${scope.project.projectId}, scope_key = ${axisProjectScopeKey(scope.project)},
            thread_id = ${storedTask.threadId}
        WHERE id = ${storedTask.id}
      `;
      yield* sql`UPDATE axis_task_extensions SET environment_id = 'different-environment' WHERE id = ${storedTask.id}`;
      assert.instanceOf(
        yield* Effect.flip(store.get(scope, storedTask.threadId)),
        AxisTaskPersistenceError,
      );
      yield* restorePhysicalIdentity();

      yield* sql`UPDATE axis_task_extensions SET project_id = 'different-project' WHERE id = ${storedTask.id}`;
      assert.instanceOf(
        yield* Effect.flip(store.get(scope, storedTask.threadId)),
        AxisTaskPersistenceError,
      );
      yield* restorePhysicalIdentity();

      yield* sql`UPDATE axis_task_extensions SET thread_id = 'different-thread' WHERE id = ${storedTask.id}`;
      assert.instanceOf(yield* Effect.flip(store.list(scope)), AxisTaskPersistenceError);
      yield* restorePhysicalIdentity();

      const alternateContextScope = decodeScope({
        contextId: "different-context",
        project: scope.project,
      });
      yield* sql`
        UPDATE axis_task_extensions SET context_id = ${alternateContextScope.contextId}
        WHERE id = ${storedTask.id}
      `;
      assert.instanceOf(
        yield* Effect.flip(store.get(alternateContextScope, storedTask.threadId)),
        AxisTaskPersistenceError,
      );
      yield* restorePhysicalIdentity();

      const alternateProjectScope = decodeScope({
        contextId: scope.contextId,
        project: { environmentId: "different-environment", projectId: "different-project" },
      });
      yield* sql`
        UPDATE axis_task_extensions
        SET scope_key = ${axisProjectScopeKey(alternateProjectScope.project)}
        WHERE id = ${storedTask.id}
      `;
      assert.instanceOf(
        yield* Effect.flip(store.get(alternateProjectScope, storedTask.threadId)),
        AxisTaskPersistenceError,
      );
      yield* restorePhysicalIdentity();

      const jsonVariants = [
        decodeTask({
          ...storedTask,
          scope: { ...storedTask.scope, contextId: "json-context" },
        }),
        decodeTask({
          ...storedTask,
          scope: {
            ...storedTask.scope,
            project: { ...storedTask.scope.project, environmentId: "json-environment" },
          },
        }),
        decodeTask({
          ...storedTask,
          scope: {
            ...storedTask.scope,
            project: { ...storedTask.scope.project, projectId: "json-project" },
          },
        }),
        decodeTask({ ...storedTask, threadId: "json-thread" }),
      ];
      for (const variant of jsonVariants) {
        yield* sql`
          UPDATE axis_task_extensions SET task_json = ${encodeTaskJson(variant)} WHERE id = ${storedTask.id}
        `;
        assert.instanceOf(
          yield* Effect.flip(store.get(scope, storedTask.threadId)),
          AxisTaskPersistenceError,
        );
        yield* sql`
          UPDATE axis_task_extensions SET task_json = ${encodeTaskJson(storedTask)} WHERE id = ${storedTask.id}
        `;
      }
    }),
  );

  it.effect("supports revisioned pause, reopen, and source unlink with lifecycle history", () =>
    Effect.gen(function* () {
      const store = yield* AxisTaskStore;
      const task2 = { ...task, id: "task_2", threadId: "thread_2" };
      const storedTask2 = decodeTask(task2);
      yield* store.create(storedTask2, command("command_create_2"));
      const paused = yield* store.pause({
        scope,
        threadId: storedTask2.threadId,
        taskId: storedTask2.id,
        expectedRevision: 0,
        commandId: command("command_pause_2"),
      });
      assert.equal(paused.status, "paused");
      const pausedRetry = yield* store.pause({
        scope,
        threadId: storedTask2.threadId,
        taskId: storedTask2.id,
        expectedRevision: 0,
        commandId: command("command_pause_2"),
      });
      assert.equal(pausedRetry.revision, paused.revision);
      const stale = yield* Effect.flip(
        store.pause({
          scope,
          threadId: storedTask2.threadId,
          taskId: storedTask2.id,
          expectedRevision: 0,
          commandId: command("command_pause_stale"),
        }),
      );
      assert.instanceOf(stale, AxisTaskConflictError);
      const reopened = yield* store.reopen({
        scope,
        threadId: storedTask2.threadId,
        taskId: storedTask2.id,
        expectedRevision: 1,
        commandId: command("command_reopen_2"),
      });
      const unlinked = yield* store.unlinkSource({
        scope,
        threadId: storedTask2.threadId,
        taskId: storedTask2.id,
        expectedRevision: 2,
        commandId: command("command_unlink_2"),
      });
      assert.equal(reopened.status, "active");
      assert.equal(unlinked.source, undefined);
      const lifecycle = yield* store.listLifecycle(scope, storedTask2.threadId);
      assert.deepEqual(
        lifecycle.map((event) => event.action),
        ["created", "paused", "reopened", "source-unlinked"],
      );
      const originalSource = lifecycle[0]?.task.source;
      assert.equal(originalSource?.kind, "jira");
      if (originalSource !== undefined && originalSource.kind === "jira") {
        assert.equal(originalSource.issueKey, "AX-1");
      }
      assert.equal(lifecycle[3]?.task.source, undefined);
      assert.equal(
        Option.getOrThrow(yield* store.get(scope, storedTask2.threadId)).status,
        "active",
      );
    }),
  );

  it.effect("rejects lifecycle rows whose physical identity differs from event JSON", () =>
    Effect.gen(function* () {
      const store = yield* AxisTaskStore;
      const sql = yield* SqlClient.SqlClient;
      const storedTask = decodeTask({
        ...task,
        id: "task_event_identity",
        threadId: "thread_event_identity",
      });
      yield* store.create(storedTask, command("command_event_identity_create"));

      const restorePhysicalIdentity = () => sql`
        UPDATE axis_task_lifecycle_events
        SET context_id = ${scope.contextId}, scope_key = ${axisProjectScopeKey(scope.project)},
            thread_id = ${storedTask.threadId}, task_id = ${storedTask.id}
        WHERE task_id = ${storedTask.id} OR task_id = 'different-task'
      `;
      yield* sql`UPDATE axis_task_lifecycle_events SET thread_id = 'different-thread' WHERE task_id = ${storedTask.id}`;
      assert.instanceOf(
        yield* Effect.flip(store.listLifecycle(scope, ThreadId.make("different-thread"))),
        AxisTaskPersistenceError,
      );
      yield* restorePhysicalIdentity();

      yield* sql`UPDATE axis_task_lifecycle_events SET task_id = 'different-task' WHERE task_id = ${storedTask.id}`;
      assert.instanceOf(
        yield* Effect.flip(store.listLifecycle(scope, storedTask.threadId)),
        AxisTaskPersistenceError,
      );
      yield* restorePhysicalIdentity();

      const alternateContextScope = decodeScope({
        contextId: "different-context",
        project: scope.project,
      });
      yield* sql`
        UPDATE axis_task_lifecycle_events SET context_id = ${alternateContextScope.contextId}
        WHERE task_id = ${storedTask.id}
      `;
      assert.instanceOf(
        yield* Effect.flip(store.listLifecycle(alternateContextScope, storedTask.threadId)),
        AxisTaskPersistenceError,
      );
      yield* restorePhysicalIdentity();

      const alternateProjectScope = decodeScope({
        contextId: scope.contextId,
        project: { environmentId: "different-environment", projectId: "different-project" },
      });
      yield* sql`
        UPDATE axis_task_lifecycle_events
        SET scope_key = ${axisProjectScopeKey(alternateProjectScope.project)}
        WHERE task_id = ${storedTask.id}
      `;
      assert.instanceOf(
        yield* Effect.flip(store.listLifecycle(alternateProjectScope, storedTask.threadId)),
        AxisTaskPersistenceError,
      );
      yield* restorePhysicalIdentity();

      const [eventRow] = yield* sql<{ readonly eventJson: string }>`
        SELECT event_json AS "eventJson"
        FROM axis_task_lifecycle_events
        WHERE task_id = ${storedTask.id}
      `;
      const eventJson = decodeEventJson(eventRow?.eventJson ?? "");
      const tamperedEvent = decodeEvent({
        ...eventJson,
        task: { ...eventJson.task, threadId: "json-event-thread" },
      });
      const tamperedEventJson = encodeEventJson(tamperedEvent);
      yield* sql`
        UPDATE axis_task_lifecycle_events SET event_json = ${tamperedEventJson} WHERE task_id = ${storedTask.id}
      `;
      assert.instanceOf(
        yield* Effect.flip(store.listLifecycle(scope, storedTask.threadId)),
        AxisTaskPersistenceError,
      );
    }),
  );

  it.effect("isolates tasks by context scope and does not persist provider state", () =>
    Effect.gen(function* () {
      const store = yield* AxisTaskStore;
      const sql = yield* SqlClient.SqlClient;
      const otherScope = decodeScope({
        contextId: "personal_isolated",
        project: { environmentId: "env", projectId: "project" },
      });
      const isolatedScope = decodeScope({
        contextId: "company_isolated",
        project: { environmentId: "env", projectId: "project" },
      });
      const isolatedTask = decodeTask({
        ...task,
        id: "task_isolated",
        scope: isolatedScope,
        threadId: "thread_isolated",
      });
      const otherTask = decodeTask({
        id: "task_other_scope",
        scope: otherScope,
        threadId: "thread_isolated",
        source: task.source,
        title: task.title,
        acceptanceCriteria: task.acceptanceCriteria,
        workflowVersion: task.workflowVersion,
        steps: task.steps,
        status: task.status,
        revision: 0,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      });

      yield* store.create(isolatedTask, command("command_scoped_company"));
      yield* store.create(otherTask, command("command_scoped_personal"));

      assert.equal((yield* store.list(isolatedScope)).length, 1);
      assert.equal((yield* store.list(otherScope)).length, 1);
      assert.isTrue(
        Option.isNone(yield* store.get(isolatedScope, ThreadId.make("thread_missing"))),
      );

      const rows = yield* sql<{ readonly taskJson: string }>`
        SELECT task_json AS "taskJson"
        FROM axis_task_extensions
        WHERE context_id = ${isolatedScope.contextId}
      `;
      assert.notInclude(rows[0]?.taskJson ?? "", "messages");
      assert.notInclude(rows[0]?.taskJson ?? "", "providerState");
      assert.notInclude(rows[0]?.taskJson ?? "", "sessionId");
    }),
  );

  it.effect("rejects an update whose task revision skips the expected CAS revision", () =>
    Effect.gen(function* () {
      const store = yield* AxisTaskStore;
      const task3 = decodeTask({ ...task, id: "task_3", threadId: "thread_3" });
      yield* store.create(task3, command("command_create_3"));

      const error = yield* Effect.flip(
        store.update({
          task: { ...task3, title: "Skipped revision", revision: 2 },
          expectedRevision: 0,
          commandId: command("command_update_skipped_revision"),
        }),
      );

      assert.instanceOf(error, AxisTaskConflictError);
      assert.equal(Option.getOrThrow(yield* store.get(scope, task3.threadId)).revision, 0);
    }),
  );

  it.effect("rejects a create that starts at a non-zero revision", () =>
    Effect.gen(function* () {
      const store = yield* AxisTaskStore;
      const nonzeroTask = decodeTask({
        ...task,
        id: "task_nonzero",
        threadId: "thread_nonzero",
        revision: 1,
      });
      const error = yield* Effect.flip(
        store.create(nonzeroTask, command("command_create_nonzero")),
      );

      assert.instanceOf(error, AxisTaskValidationError);
      assert.isTrue(Option.isNone(yield* store.get(scope, nonzeroTask.threadId)));
    }),
  );

  it.effect("rejects a create for a missing or differently scoped physical thread", () =>
    Effect.gen(function* () {
      const store = yield* AxisTaskStore;
      const sql = yield* SqlClient.SqlClient;
      const beforeRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM axis_task_extensions
      `;
      const missingThread = decodeTask({
        ...task,
        id: "task_missing_thread",
        threadId: "thread_missing",
      });
      const missingError = yield* Effect.flip(
        store.create(missingThread, command("command_missing_thread")),
      );
      assert.instanceOf(missingError, AxisTaskValidationError);

      const wrongProjectTask = decodeTask({
        ...task,
        id: "task_wrong_project",
        threadId: "thread_wrong_project",
      });
      const wrongProjectError = yield* Effect.flip(
        store.create(wrongProjectTask, command("command_wrong_project")),
      );
      assert.instanceOf(wrongProjectError, AxisTaskValidationError);

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM axis_task_extensions
      `;
      assert.equal(rows[0]?.count, beforeRows[0]?.count);
    }),
  );

  it.effect("rejects a project/thread pairing from another environment", () =>
    Effect.gen(function* () {
      const store = yield* AxisTaskStore;
      const sql = yield* SqlClient.SqlClient;
      const foreignScope = decodeScope({
        contextId: scope.contextId,
        project: { environmentId: "foreign-environment", projectId: scope.project.projectId },
      });
      const foreignEnvironmentTask = decodeTask({
        ...task,
        id: "task_foreign_environment",
        scope: foreignScope,
        threadId: task.threadId,
      });
      const beforeRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM axis_task_extensions
      `;

      const error = yield* Effect.flip(
        store.create(foreignEnvironmentTask, command("command_foreign_environment")),
      );

      assert.instanceOf(error, AxisTaskValidationError);
      const afterRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM axis_task_extensions
      `;
      assert.equal(afterRows[0]?.count, beforeRows[0]?.count);
    }),
  );
});

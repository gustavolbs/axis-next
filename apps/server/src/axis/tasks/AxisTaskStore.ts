import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import {
  AxisContextProjectScope,
  axisProjectScopeKey,
} from "../../../../../packages/contracts/src/axisProjectProfile.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  AxisTaskCommandConflictError,
  AxisTaskConflictError,
  AxisTaskExtension,
  AxisTaskPersistenceError,
  AxisTaskValidationError,
  type AxisTaskExtension as AxisTaskExtensionType,
  type AxisTaskLifecycleInput,
  type AxisTaskMutation,
  type AxisTaskStoreError,
} from "../../../../../packages/contracts/src/axisTask.ts";
import type { CommandId, ThreadId } from "../../../../../packages/contracts/src/baseSchemas.ts";

export {
  AxisTaskCommandConflictError,
  AxisTaskConflictError,
  AxisTaskPersistenceError,
} from "../../../../../packages/contracts/src/axisTask.ts";

type TaskRow = {
  readonly id: unknown;
  readonly contextId: unknown;
  readonly environmentId: unknown;
  readonly projectId: unknown;
  readonly scopeKey: unknown;
  readonly threadId: unknown;
  readonly value: unknown;
  readonly revision: unknown;
};
/** Lifecycle rows encode the project tuple in scope_key instead of duplicate columns. */
type TaskEventRow = {
  readonly contextId: unknown;
  readonly scopeKey: unknown;
  readonly threadId: unknown;
  readonly taskId: unknown;
  readonly value: unknown;
};
type CommandRow = { readonly taskId: string; readonly requestDigest: string };
type TaskEvent = {
  readonly action: "created" | "updated" | "paused" | "reopened" | "source-unlinked";
  readonly task: AxisTaskExtensionType;
  readonly createdAt: string;
};

const encodeTask = Schema.encodeEffect(Schema.fromJsonString(AxisTaskExtension));
const decodeTask = Schema.decodeUnknownEffect(Schema.fromJsonString(AxisTaskExtension));
const TaskEventSchema = Schema.Struct({
  action: Schema.Literals(["created", "updated", "paused", "reopened", "source-unlinked"]),
  task: AxisTaskExtension,
  createdAt: Schema.String,
});
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(TaskEventSchema));
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(TaskEventSchema));
const scopeKey = (scope: AxisContextProjectScope) => axisProjectScopeKey(scope.project);
const digest = (value: unknown) =>
  `sha256:${NodeCrypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
const persistenceError = (operation: string) => () => new AxisTaskPersistenceError({ operation });

const taskIdentityMatchesRow = (
  task: AxisTaskExtensionType,
  row: Pick<TaskRow, "id" | "contextId" | "environmentId" | "projectId" | "scopeKey" | "threadId">,
) =>
  task.id === row.id &&
  task.scope.contextId === row.contextId &&
  task.scope.project.environmentId === row.environmentId &&
  task.scope.project.projectId === row.projectId &&
  scopeKey(task.scope) === row.scopeKey &&
  task.threadId === row.threadId;

const decodeTaskRow = (row: TaskRow) =>
  decodeTask(row.value).pipe(
    Effect.flatMap((task) =>
      taskIdentityMatchesRow(task, row) && task.revision === row.revision
        ? Effect.succeed(task)
        : Effect.fail(new AxisTaskPersistenceError({ operation: "validate task row" })),
    ),
  );

const decodeTaskEventRow = (row: TaskEventRow) =>
  decodeEvent(row.value).pipe(
    Effect.flatMap((event) =>
      event.task.id === row.taskId &&
      event.task.scope.contextId === row.contextId &&
      scopeKey(event.task.scope) === row.scopeKey &&
      event.task.threadId === row.threadId
        ? Effect.succeed(event)
        : Effect.fail(new AxisTaskPersistenceError({ operation: "validate task lifecycle row" })),
    ),
  );

const taskConflict = (taskId: string) => Effect.fail(new AxisTaskConflictError({ taskId }));

export class AxisTaskStore extends Context.Service<
  AxisTaskStore,
  {
    readonly get: (
      scope: AxisContextProjectScope,
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<AxisTaskExtensionType>, AxisTaskPersistenceError>;
    readonly list: (
      scope: AxisContextProjectScope,
    ) => Effect.Effect<ReadonlyArray<AxisTaskExtensionType>, AxisTaskPersistenceError>;
    readonly create: (
      task: AxisTaskExtensionType,
      commandId: CommandId,
    ) => Effect.Effect<AxisTaskExtensionType, AxisTaskStoreError>;
    readonly update: (
      mutation: AxisTaskMutation,
    ) => Effect.Effect<AxisTaskExtensionType, AxisTaskStoreError>;
    readonly pause: (
      input: AxisTaskLifecycleInput,
    ) => Effect.Effect<AxisTaskExtensionType, AxisTaskStoreError>;
    readonly reopen: (
      input: AxisTaskLifecycleInput,
    ) => Effect.Effect<AxisTaskExtensionType, AxisTaskStoreError>;
    readonly unlinkSource: (
      input: AxisTaskLifecycleInput,
    ) => Effect.Effect<AxisTaskExtensionType, AxisTaskStoreError>;
    readonly listLifecycle: (
      scope: AxisContextProjectScope,
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<TaskEvent>, AxisTaskPersistenceError>;
  }
>()("t3/axis/tasks/AxisTaskStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const projectionSnapshotQuery = yield* Effect.serviceOption(
    ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  );

  const validateThread = (task: AxisTaskExtensionType) =>
    Effect.gen(function* () {
      const environmentId = yield* serverEnvironment.getEnvironmentId;
      if (environmentId !== task.scope.project.environmentId) {
        return yield* new AxisTaskValidationError({
          message: "The task project belongs to another server environment.",
        });
      }
      if (Option.isNone(projectionSnapshotQuery)) {
        return yield* new AxisTaskValidationError({
          message: "Axis task creation requires the thread projection query.",
        });
      }
      const thread = yield* projectionSnapshotQuery.value
        .getThreadShellById(task.threadId)
        .pipe(
          Effect.mapError(
            () => new AxisTaskPersistenceError({ operation: "validate task thread" }),
          ),
        );
      if (Option.isNone(thread)) {
        return yield* new AxisTaskValidationError({
          message: "The task thread does not exist.",
        });
      }
      if (thread.value.projectId !== task.scope.project.projectId) {
        return yield* new AxisTaskValidationError({
          message: "The task thread does not belong to the task project.",
        });
      }
    });

  const get: AxisTaskStore["Service"]["get"] = (scope, threadId) =>
    sql<TaskRow>`
      SELECT
        id,
        context_id AS "contextId",
        environment_id AS "environmentId",
        project_id AS "projectId",
        scope_key AS "scopeKey",
        thread_id AS "threadId",
        task_json AS value,
        revision
      FROM axis_task_extensions
      WHERE (
        json_extract(task_json, '$.scope.contextId') = ${scope.contextId}
        AND json_extract(task_json, '$.scope.project.environmentId') = ${scope.project.environmentId}
        AND json_extract(task_json, '$.scope.project.projectId') = ${scope.project.projectId}
        AND json_extract(task_json, '$.threadId') = ${threadId}
      ) OR (
        context_id = ${scope.contextId} AND scope_key = ${scopeKey(scope)} AND thread_id = ${threadId}
      )
    `.pipe(
      Effect.mapError(persistenceError("read task")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeTaskRow(row).pipe(Effect.mapError(persistenceError("decode task"))),
        ).pipe(
          Effect.map((tasks) =>
            tasks[0] === undefined ? Option.none<AxisTaskExtensionType>() : Option.some(tasks[0]),
          ),
        ),
      ),
    );

  const list: AxisTaskStore["Service"]["list"] = (scope) =>
    sql<TaskRow>`
      SELECT
        id,
        context_id AS "contextId",
        environment_id AS "environmentId",
        project_id AS "projectId",
        scope_key AS "scopeKey",
        thread_id AS "threadId",
        task_json AS value,
        revision
      FROM axis_task_extensions
      WHERE (
        json_extract(task_json, '$.scope.contextId') = ${scope.contextId}
        AND json_extract(task_json, '$.scope.project.environmentId') = ${scope.project.environmentId}
        AND json_extract(task_json, '$.scope.project.projectId') = ${scope.project.projectId}
      ) OR (
        context_id = ${scope.contextId} AND scope_key = ${scopeKey(scope)}
      )
      ORDER BY updated_at DESC, id
    `.pipe(
      Effect.mapError(persistenceError("list tasks")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeTaskRow(row).pipe(Effect.mapError(persistenceError("decode task"))),
        ),
      ),
    );

  const command = (scope: AxisContextProjectScope, threadId: ThreadId, commandId: CommandId) =>
    sql<CommandRow>`
      SELECT task_id AS "taskId", request_digest AS "requestDigest"
      FROM axis_task_commands
      WHERE command_id = ${commandId} AND context_id = ${scope.contextId}
        AND scope_key = ${scopeKey(scope)} AND thread_id = ${threadId}
    `.pipe(Effect.mapError(persistenceError("read task command")));

  const saveEvent = (event: TaskEvent) =>
    encodeEvent(event).pipe(
      Effect.mapError(persistenceError("encode task event")),
      Effect.flatMap(
        (json) =>
          sql`
          INSERT INTO axis_task_lifecycle_events
            (context_id, scope_key, thread_id, task_id, action, event_json, created_at)
          VALUES
            (${event.task.scope.contextId}, ${scopeKey(event.task.scope)}, ${event.task.threadId},
             ${event.task.id}, ${event.action}, ${json}, ${event.createdAt})
        `,
      ),
      Effect.mapError(persistenceError("save task event")),
    );

  const create: AxisTaskStore["Service"]["create"] = (task, commandId) => {
    if (task.revision !== 0) {
      return Effect.fail(
        new AxisTaskValidationError({
          message: "A new task must start at revision 0.",
        }),
      );
    }
    const requestDigest = digest({ action: "create", task });
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const previous = yield* command(task.scope, task.threadId, commandId);
          if (previous[0] !== undefined) {
            if (previous[0].requestDigest !== requestDigest) {
              return yield* new AxisTaskCommandConflictError({ commandId });
            }
            return yield* get(task.scope, task.threadId).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => taskConflict(previous[0]!.taskId),
                  onSome: (existing) =>
                    existing.id === previous[0]!.taskId
                      ? Effect.succeed(existing)
                      : taskConflict(previous[0]!.taskId),
                }),
              ),
            );
          }
          const existing = yield* get(task.scope, task.threadId);
          if (Option.isSome(existing)) {
            return yield* taskConflict(existing.value.id);
          }
          yield* validateThread(task);
          const encoded = yield* encodeTask(task).pipe(
            Effect.mapError(persistenceError("encode task")),
          );
          const now = DateTime.formatIso(DateTime.nowUnsafe());
          yield* sql`
          INSERT INTO axis_task_extensions
            (id, context_id, environment_id, project_id, scope_key, thread_id, task_json, revision, created_at, updated_at)
          VALUES
            (${task.id}, ${task.scope.contextId}, ${task.scope.project.environmentId}, ${task.scope.project.projectId},
             ${scopeKey(task.scope)}, ${task.threadId}, ${encoded}, ${task.revision}, ${task.createdAt}, ${task.updatedAt})
        `.pipe(Effect.mapError(persistenceError("create task")));
          yield* sql`
          INSERT INTO axis_task_commands
            (command_id, context_id, scope_key, thread_id, task_id, request_digest, created_at)
          VALUES (${commandId}, ${task.scope.contextId}, ${scopeKey(task.scope)}, ${task.threadId}, ${task.id}, ${requestDigest}, ${now})
        `.pipe(Effect.mapError(persistenceError("save task command")));
          yield* saveEvent({ action: "created", task, createdAt: now });
          return task;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", () =>
          Effect.fail(new AxisTaskPersistenceError({ operation: "create task" })),
        ),
      );
  };

  const updateWithAction = (
    mutation: AxisTaskMutation,
    action: TaskEvent["action"],
    requestDigest = digest({
      action,
      task: mutation.task,
      expectedRevision: mutation.expectedRevision,
    }),
  ) => {
    const { task, expectedRevision, commandId } = mutation;
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const previous = yield* command(task.scope, task.threadId, commandId);
          if (previous[0] !== undefined) {
            if (previous[0].requestDigest !== requestDigest) {
              return yield* new AxisTaskCommandConflictError({ commandId });
            }
            return yield* get(task.scope, task.threadId).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => taskConflict(previous[0]!.taskId),
                  onSome: (existing) =>
                    existing.id === previous[0]!.taskId
                      ? Effect.succeed(existing)
                      : taskConflict(previous[0]!.taskId),
                }),
              ),
            );
          }
          const current = yield* get(task.scope, task.threadId);
          if (
            Option.isNone(current) ||
            current.value.id !== task.id ||
            current.value.revision !== expectedRevision
          ) {
            return yield* taskConflict(task.id);
          }
          if (task.revision !== expectedRevision + 1) {
            return yield* taskConflict(task.id);
          }
          const encoded = yield* encodeTask(task).pipe(
            Effect.mapError(persistenceError("encode task")),
          );
          const now = DateTime.formatIso(DateTime.nowUnsafe());
          const rows = yield* sql<{ readonly id: string }>`
          UPDATE axis_task_extensions
          SET task_json = ${encoded}, revision = ${task.revision}, updated_at = ${task.updatedAt}
          WHERE context_id = ${task.scope.contextId} AND scope_key = ${scopeKey(task.scope)}
            AND thread_id = ${task.threadId} AND id = ${task.id} AND revision = ${expectedRevision}
          RETURNING id
        `.pipe(Effect.mapError(persistenceError("update task")));
          if (rows.length === 0) return yield* taskConflict(task.id);
          yield* sql`
          INSERT INTO axis_task_commands
            (command_id, context_id, scope_key, thread_id, task_id, request_digest, created_at)
          VALUES (${commandId}, ${task.scope.contextId}, ${scopeKey(task.scope)}, ${task.threadId}, ${task.id}, ${requestDigest}, ${now})
        `.pipe(Effect.mapError(persistenceError("save task command")));
          yield* saveEvent({ action, task, createdAt: now });
          return task;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", () =>
          Effect.fail(new AxisTaskPersistenceError({ operation: "update task" })),
        ),
      );
  };

  const update: AxisTaskStore["Service"]["update"] = (mutation) =>
    updateWithAction(mutation, "updated");

  const transition = (
    action: "paused" | "reopened" | "source-unlinked",
    input: AxisTaskLifecycleInput,
  ) =>
    get(input.scope, input.threadId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new AxisTaskConflictError({ taskId: input.taskId })),
          onSome: (task) => {
            if (task.id !== input.taskId) {
              return Effect.fail(new AxisTaskConflictError({ taskId: input.taskId }));
            }
            const next = {
              ...task,
              ...(action === "paused"
                ? { status: "paused" as const }
                : action === "reopened"
                  ? { status: "active" as const }
                  : {}),
              revision: input.expectedRevision + 1,
              updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
            };
            const nextTask =
              action === "source-unlinked"
                ? (() => {
                    const { source: _source, ...withoutSource } = next;
                    return withoutSource;
                  })()
                : next;
            return updateWithAction(
              {
                task: nextTask,
                expectedRevision: input.expectedRevision,
                commandId: input.commandId,
              },
              action,
              digest({
                action,
                scope: input.scope,
                threadId: input.threadId,
                taskId: input.taskId,
                expectedRevision: input.expectedRevision,
              }),
            );
          },
        }),
      ),
    );

  const listLifecycle: AxisTaskStore["Service"]["listLifecycle"] = (scope, threadId) =>
    sql<TaskEventRow>`
      SELECT
        context_id AS "contextId",
        scope_key AS "scopeKey",
        thread_id AS "threadId",
        task_id AS "taskId",
        event_json AS value
      FROM axis_task_lifecycle_events
      WHERE (
        json_extract(event_json, '$.task.scope.contextId') = ${scope.contextId}
        AND json_extract(event_json, '$.task.scope.project.environmentId') = ${scope.project.environmentId}
        AND json_extract(event_json, '$.task.scope.project.projectId') = ${scope.project.projectId}
        AND json_extract(event_json, '$.task.threadId') = ${threadId}
      ) OR (
        context_id = ${scope.contextId} AND scope_key = ${scopeKey(scope)} AND thread_id = ${threadId}
      )
      ORDER BY created_at, id
    `.pipe(
      Effect.mapError(persistenceError("list task lifecycle")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeTaskEventRow(row).pipe(Effect.mapError(persistenceError("decode task lifecycle"))),
        ),
      ),
    );

  return {
    get,
    list,
    create,
    update,
    pause: (input) => transition("paused", input),
    reopen: (input) => transition("reopened", input),
    unlinkSource: (input) => transition("source-unlinked", input),
    listLifecycle,
  } satisfies AxisTaskStore["Service"];
});

export const layer = Layer.effect(AxisTaskStore, make);

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AxisScheduledActivity,
  AxisScheduledActivityConflictError,
  type AxisScheduledActivityError,
  type AxisScheduledActivityId,
  AxisScheduledActivityNotFoundError,
  AxisScheduledActivityPersistenceError,
  AxisScheduledActivityRun,
  type AxisScheduledActivityRun as AxisScheduledActivityRunType,
  type AxisScheduledActivity as AxisScheduledActivityType,
} from "@t3tools/contracts";

type ActivityRow = { readonly activityJson: unknown };
type RunRow = { readonly runJson: unknown };

const decodeActivity = Schema.decodeUnknownEffect(Schema.fromJsonString(AxisScheduledActivity));
const encodeActivity = Schema.encodeEffect(Schema.fromJsonString(AxisScheduledActivity));
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(AxisScheduledActivityRun));
const encodeRun = Schema.encodeEffect(Schema.fromJsonString(AxisScheduledActivityRun));
const persistenceError = (operation: string) => () =>
  new AxisScheduledActivityPersistenceError({ operation });

export class AxisScheduledActivityStore extends Context.Service<
  AxisScheduledActivityStore,
  {
    readonly list: Effect.Effect<
      ReadonlyArray<AxisScheduledActivityType>,
      AxisScheduledActivityPersistenceError
    >;
    readonly listDue: (
      now: string,
    ) => Effect.Effect<
      ReadonlyArray<AxisScheduledActivityType>,
      AxisScheduledActivityPersistenceError
    >;
    readonly get: (
      id: AxisScheduledActivityId,
    ) => Effect.Effect<AxisScheduledActivityType, AxisScheduledActivityError>;
    readonly create: (
      activity: AxisScheduledActivityType,
    ) => Effect.Effect<AxisScheduledActivityType, AxisScheduledActivityError>;
    readonly update: (
      activity: AxisScheduledActivityType,
    ) => Effect.Effect<AxisScheduledActivityType, AxisScheduledActivityError>;
    readonly remove: (
      id: AxisScheduledActivityId,
    ) => Effect.Effect<void, AxisScheduledActivityError>;
    readonly saveRun: (
      run: AxisScheduledActivityRunType,
    ) => Effect.Effect<void, AxisScheduledActivityPersistenceError>;
    readonly listRuns: (
      activityId: AxisScheduledActivityId,
      limit: number,
    ) => Effect.Effect<
      ReadonlyArray<AxisScheduledActivityRunType>,
      AxisScheduledActivityPersistenceError
    >;
    /** Marks run records left in-flight by a prior server process as failed. */
    readonly recoverInterruptedRuns: (
      finishedAt: string,
    ) => Effect.Effect<number, AxisScheduledActivityPersistenceError>;
  }
>()("t3/axis/scheduled/AxisScheduledActivityStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const decodeActivities = (rows: ReadonlyArray<ActivityRow>, operation: string) =>
    Effect.forEach(rows, (row) => decodeActivity(row.activityJson), { concurrency: 8 }).pipe(
      Effect.mapError(persistenceError(operation)),
    );

  const list: AxisScheduledActivityStore["Service"]["list"] = sql<ActivityRow>`
    SELECT activity_json AS "activityJson"
    FROM axis_scheduled_activities
    ORDER BY next_run_at, id
  `.pipe(
    Effect.mapError(persistenceError("list scheduled activities")),
    Effect.flatMap((rows) => decodeActivities(rows, "decode scheduled activities")),
  );

  const listDue: AxisScheduledActivityStore["Service"]["listDue"] = (now) =>
    sql<ActivityRow>`
      SELECT activity_json AS "activityJson"
      FROM axis_scheduled_activities
      WHERE enabled = 1 AND next_run_at <= ${now}
      ORDER BY next_run_at, id
    `.pipe(
      Effect.mapError(persistenceError("list due scheduled activities")),
      Effect.flatMap((rows) => decodeActivities(rows, "decode due scheduled activities")),
    );

  const get: AxisScheduledActivityStore["Service"]["get"] = (id) =>
    sql<ActivityRow>`
      SELECT activity_json AS "activityJson"
      FROM axis_scheduled_activities
      WHERE id = ${id}
    `.pipe(
      Effect.mapError(persistenceError("read scheduled activity")),
      Effect.flatMap(
        (rows): Effect.Effect<AxisScheduledActivityType, AxisScheduledActivityError> =>
          rows[0] === undefined
            ? Effect.fail(new AxisScheduledActivityNotFoundError({ id }))
            : decodeActivity(rows[0].activityJson).pipe(
                Effect.mapError(persistenceError("decode scheduled activity")),
              ),
      ),
    );

  const create: AxisScheduledActivityStore["Service"]["create"] = (activity) =>
    encodeActivity(activity).pipe(
      Effect.mapError(persistenceError("encode scheduled activity")),
      Effect.flatMap(
        (activityJson) =>
          sql<{ readonly id: string }>`
          INSERT INTO axis_scheduled_activities (
            id, context_id, activity_json, enabled, next_run_at, updated_at
          ) VALUES (
            ${activity.id}, ${activity.contextId}, ${activityJson},
            ${activity.enabled ? 1 : 0}, ${activity.nextRunAt}, ${activity.updatedAt}
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `,
      ),
      Effect.mapError(persistenceError("create scheduled activity")),
      Effect.flatMap((rows) =>
        rows.length === 0
          ? Effect.fail(new AxisScheduledActivityConflictError({ id: activity.id }))
          : Effect.succeed(activity),
      ),
    );

  const update: AxisScheduledActivityStore["Service"]["update"] = (activity) =>
    encodeActivity(activity).pipe(
      Effect.mapError(persistenceError("encode scheduled activity")),
      Effect.flatMap(
        (activityJson) =>
          sql<{ readonly id: string }>`
          UPDATE axis_scheduled_activities
          SET context_id = ${activity.contextId},
              activity_json = ${activityJson},
              enabled = ${activity.enabled ? 1 : 0},
              next_run_at = ${activity.nextRunAt},
              updated_at = ${activity.updatedAt}
          WHERE id = ${activity.id}
          RETURNING id
        `,
      ),
      Effect.mapError(persistenceError("update scheduled activity")),
      Effect.flatMap((rows) =>
        rows.length === 0
          ? Effect.fail(new AxisScheduledActivityNotFoundError({ id: activity.id }))
          : Effect.succeed(activity),
      ),
    );

  const remove: AxisScheduledActivityStore["Service"]["remove"] = (id) =>
    sql<{
      readonly id: string;
    }>`DELETE FROM axis_scheduled_activities WHERE id = ${id} RETURNING id`.pipe(
      Effect.mapError(persistenceError("delete scheduled activity")),
      Effect.flatMap((rows) =>
        rows.length === 0
          ? Effect.fail(new AxisScheduledActivityNotFoundError({ id }))
          : Effect.void,
      ),
    );

  const saveRun: AxisScheduledActivityStore["Service"]["saveRun"] = (run) =>
    encodeRun(run).pipe(
      Effect.mapError(persistenceError("encode scheduled activity run")),
      Effect.flatMap(
        (runJson) => sql`
        INSERT INTO axis_scheduled_activity_runs (id, activity_id, run_json, started_at)
        VALUES (${run.id}, ${run.activityId}, ${runJson}, ${run.startedAt})
        ON CONFLICT (id) DO UPDATE SET run_json = excluded.run_json
      `,
      ),
      Effect.asVoid,
      Effect.mapError(persistenceError("save scheduled activity run")),
    );

  const listRuns: AxisScheduledActivityStore["Service"]["listRuns"] = (activityId, limit) =>
    sql<RunRow>`
      SELECT run_json AS "runJson"
      FROM axis_scheduled_activity_runs
      WHERE activity_id = ${activityId}
      ORDER BY started_at DESC
      LIMIT ${limit}
    `.pipe(
      Effect.mapError(persistenceError("list scheduled activity runs")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => decodeRun(row.runJson), { concurrency: 8 }).pipe(
          Effect.mapError(persistenceError("decode scheduled activity runs")),
        ),
      ),
    );

  const recoverInterruptedRuns: AxisScheduledActivityStore["Service"]["recoverInterruptedRuns"] = (
    finishedAt,
  ) =>
    sql<RunRow>`
        SELECT run_json AS "runJson"
        FROM axis_scheduled_activity_runs
        WHERE json_extract(run_json, '$.status') = 'running'
      `.pipe(
      Effect.mapError(persistenceError("list interrupted scheduled activity runs")),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) =>
            decodeRun(row.runJson).pipe(
              Effect.mapError(persistenceError("decode interrupted scheduled activity run")),
              Effect.flatMap((run) =>
                saveRun({
                  ...run,
                  status: "failed",
                  finishedAt,
                  message: "The server stopped before this run finished; the schedule may retry.",
                }),
              ),
            ),
          { concurrency: 8, discard: true },
        ).pipe(Effect.as(rows.length)),
      ),
    );

  return {
    list,
    listDue,
    get,
    create,
    update,
    remove,
    saveRun,
    listRuns,
    recoverInterruptedRuns,
  } satisfies AxisScheduledActivityStore["Service"];
});

export const layer = Layer.effect(AxisScheduledActivityStore, make);

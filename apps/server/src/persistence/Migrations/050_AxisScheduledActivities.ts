import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE axis_scheduled_activities (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      activity_json TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      next_run_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX axis_scheduled_activities_due
    ON axis_scheduled_activities (enabled, next_run_at)
  `;

  yield* sql`
    CREATE TABLE axis_scheduled_activity_runs (
      id TEXT PRIMARY KEY,
      activity_id TEXT NOT NULL,
      run_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      FOREIGN KEY (activity_id) REFERENCES axis_scheduled_activities(id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX axis_scheduled_activity_runs_activity_started
    ON axis_scheduled_activity_runs (activity_id, started_at DESC)
  `;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * W09 — AxisTaskIntake.
 *
 * Stores the dedupe record between an intake command and the resulting
 * task. Reusing the same command returns the original task; reusing the
 * same source (jira issueKey or trello cardId) collapses to the same task
 * unless a new command id is supplied.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE axis_task_intake (
      id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      command_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      task_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (context_id, scope_key, command_id)
    )
  `;
  yield* sql`
    CREATE INDEX axis_task_intake_source
    ON axis_task_intake (scope_key, source_kind, source_id, created_at)
  `;
});

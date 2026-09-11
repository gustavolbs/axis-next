import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** An admitted provider attempt is immutable and must never be blindly replayed. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE axis_workflow_attempts (
      command_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES axis_task_extensions(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      request_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX axis_workflow_attempts_task
    ON axis_workflow_attempts (task_id, created_at, command_id)
  `;
});

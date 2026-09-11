import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * H05 — AxisLearningOutcomes.
 *
 * Records per-task outcomes for the learning versions that were applied or
 * rolled back. The (context_id, scope_key, command_id) tuple is unique so a
 * retry updates the row instead of creating a duplicate outcome.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE axis_learning_outcomes (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      signal TEXT NOT NULL,
      summary TEXT NOT NULL,
      version_ids_json TEXT NOT NULL,
      note TEXT,
      observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (context_id, scope_key, command_id)
    )
  `;
  yield* sql`
    CREATE INDEX axis_learning_outcomes_scope_task
    ON axis_learning_outcomes (scope_key, task_id, created_at)
  `;
});

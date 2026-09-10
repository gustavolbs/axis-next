import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Gives task mutations their own idempotency ledger without coupling them to orchestration receipts. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE axis_task_commands (
      context_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (context_id, scope_key, thread_id, command_id)
    )
  `;
  yield* sql`
    CREATE INDEX axis_task_commands_task
    ON axis_task_commands (context_id, scope_key, thread_id, created_at)
  `;
  yield* sql`
    CREATE TABLE axis_task_lifecycle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      context_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      action TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX axis_task_lifecycle_events_task
    ON axis_task_lifecycle_events (context_id, scope_key, thread_id, created_at, id)
  `;
});

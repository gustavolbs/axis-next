import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE axis_scratch_chats (
      id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      scratch_json TEXT NOT NULL,
      backing_project_id TEXT NOT NULL,
      backing_thread_id TEXT NOT NULL,
      archived_at TEXT,
      last_message_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX axis_scratch_chats_env_updated
    ON axis_scratch_chats (environment_id, archived_at, updated_at DESC)
  `;
});

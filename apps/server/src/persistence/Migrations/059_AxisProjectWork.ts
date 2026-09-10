import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Stores Axis profile/task metadata without copying T3 project or thread history. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE axis_project_profiles (
      context_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      profile_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (context_id, scope_key),
      UNIQUE (context_id, environment_id, project_id)
    )
  `;
  yield* sql`
    CREATE INDEX axis_project_profiles_scope_updated
    ON axis_project_profiles (context_id, scope_key, updated_at DESC)
  `;

  yield* sql`
    CREATE TABLE axis_task_extensions (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      task_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      UNIQUE (context_id, scope_key, thread_id),
      UNIQUE (context_id, environment_id, project_id, id)
    )
  `;
  yield* sql`
    CREATE INDEX axis_task_extensions_scope_updated
    ON axis_task_extensions (context_id, scope_key, updated_at DESC)
  `;
  yield* sql`
    CREATE INDEX axis_task_extensions_thread
    ON axis_task_extensions (context_id, environment_id, thread_id)
  `;
});

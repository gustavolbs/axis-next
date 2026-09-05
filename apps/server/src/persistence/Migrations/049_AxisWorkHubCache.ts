import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE axis_work_hub_cache (
      source_id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      refreshed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX axis_work_hub_cache_context_expires
    ON axis_work_hub_cache (context_id, expires_at)
  `;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE axis_work_hub_source_status (
      source_id TEXT PRIMARY KEY,
      last_confirmed_success_at TEXT,
      last_error_at TEXT,
      last_error_kind TEXT,
      last_error_message TEXT
    )
  `;
});

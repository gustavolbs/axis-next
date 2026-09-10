import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Records the atomic onboarding apply result for scoped command replay. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS axis_onboarding_applications (
      context_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      run_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (context_id, scope_key, command_id),
      FOREIGN KEY (context_id, scope_key, run_id)
        REFERENCES axis_onboarding_runs (context_id, scope_key, run_id)
        ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS axis_onboarding_applications_run
    ON axis_onboarding_applications (context_id, scope_key, run_id, created_at)
  `;
});

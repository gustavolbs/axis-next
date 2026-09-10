import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Adds project-scoped onboarding runs and their command idempotency ledger. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE axis_onboarding_runs (
      run_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'cancelled', 'failed', 'completed')),
      run_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (context_id, scope_key, run_id),
      UNIQUE (context_id, environment_id, project_id, run_id)
    )
  `;
  yield* sql`
    CREATE INDEX axis_onboarding_runs_scope_started
    ON axis_onboarding_runs (context_id, scope_key, started_at DESC, run_id)
  `;
  yield* sql`
    CREATE INDEX axis_onboarding_runs_execution
    ON axis_onboarding_runs (context_id, scope_key, thread_id, turn_id)
  `;

  yield* sql`
    CREATE TABLE axis_onboarding_commands (
      context_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      run_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('start', 'cancel', 'retry')),
      request_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (context_id, scope_key, command_id),
      FOREIGN KEY (context_id, scope_key, run_id)
        REFERENCES axis_onboarding_runs (context_id, scope_key, run_id)
        ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX axis_onboarding_commands_scope_created
    ON axis_onboarding_commands (context_id, scope_key, created_at, command_id)
  `;
});

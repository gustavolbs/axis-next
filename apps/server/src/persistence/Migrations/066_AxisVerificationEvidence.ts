import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * W04 — AxisVerificationEvidence.
 *
 * Records the outcome of a verification command observed during a task step.
 * Rows are immutable; if the same command is replayed with the same payload
 * the original `created_at` is preserved (idempotent insert). Different
 * payloads for the same key are detected at the API layer and rejected
 * without touching the row.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE axis_verification_evidence (
      context_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      command TEXT NOT NULL,
      exit_code INTEGER,
      observed_at TEXT NOT NULL,
      observed_revision INTEGER NOT NULL,
      covered_files_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (context_id, scope_key, task_id, step_id, command_id)
    )
  `;
  yield* sql`
    CREATE INDEX axis_verification_evidence_task_step
    ON axis_verification_evidence (task_id, step_id, created_at, command_id)
  `;
});

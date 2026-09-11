import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * W05 — AxisReviewEvidence.
 *
 * Stores self-review evidence bound to a concrete checkpoint diff so the
 * publisher can compare the recorded digest/base/head against the current
 * working tree before opening a PR. Re-recording the same commandId with
 * the same payload is idempotent; divergent payloads are rejected at the
 * API layer.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE axis_review_evidence (
      context_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      diff_digest TEXT NOT NULL,
      files_json TEXT NOT NULL,
      rules_json TEXT NOT NULL,
      findings_json TEXT NOT NULL,
      reviewer TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (context_id, scope_key, task_id, step_id, command_id)
    )
  `;
  yield* sql`
    CREATE INDEX axis_review_evidence_task_step
    ON axis_review_evidence (task_id, step_id, created_at, command_id)
  `;
});

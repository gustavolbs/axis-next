import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * W08 — AxisReviewFeedback.
 *
 * Stores per-comment review feedback as immutable evidence scoped by project.
 * Re-importing the same (source, cursor, resolution) is idempotent; conflicts
 * are rejected at the API layer.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE axis_review_feedback (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      cursor TEXT NOT NULL,
      source_url TEXT,
      comment_author TEXT NOT NULL,
      comment_body TEXT NOT NULL,
      comment_path TEXT,
      comment_line INTEGER,
      comment_severity TEXT NOT NULL,
      comment_created_at TEXT NOT NULL,
      resolution_outcome TEXT NOT NULL,
      resolution_note TEXT,
      resolution_decided_by TEXT NOT NULL,
      resolution_decided_at TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (context_id, scope_key, fingerprint)
    )
  `;
  yield* sql`
    CREATE INDEX axis_review_feedback_scope_task
    ON axis_review_feedback (scope_key, task_id, created_at)
  `;
});

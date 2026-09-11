import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * X06 — AxisJiraActionIntents.
 *
 * Persists the intent of a Jira comment/transition so a lost response can
 * be reconciled by listing remote activity, rather than replaying the
 * write. The intent key is deterministic over the (scope, issue,
 * commandId, kind) tuple so retries with the same input collapse.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE axis_jira_action_intents (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      issue_key TEXT NOT NULL,
      command_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      applied_at TEXT,
      remote_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (context_id, scope_key, issue_key, command_id)
    )
  `;
});

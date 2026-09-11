import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * X07 — AxisTrelloActionIntents.
 *
 * Stores the intent of a Trello comment/move so retries collapse and the
 * publisher reconciles by reading back the remote state, never replaying
 * the write twice.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE axis_trello_action_intents (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      card_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      applied_at TEXT,
      remote_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (context_id, scope_key, card_id, command_id)
    )
  `;
});

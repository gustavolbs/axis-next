import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Tracks which evidence has already been considered by automatic Hermes runs. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE axis_learning_evidence
    ADD COLUMN automatic_analyzed_at TEXT
  `;
  yield* sql`
    CREATE INDEX axis_learning_evidence_automatic_pending
    ON axis_learning_evidence (context_id, scope_key, automatic_analyzed_at, created_at, id)
  `;
});

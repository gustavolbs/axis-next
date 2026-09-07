import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE axis_learning_evidence (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (context_id, fingerprint)
    )
  `;
  yield* sql`
    CREATE INDEX axis_learning_evidence_expiry
    ON axis_learning_evidence (expires_at)
  `;

  yield* sql`
    CREATE TABLE axis_learning_proposals (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      target_key TEXT NOT NULL,
      status TEXT NOT NULL,
      proposal_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX axis_learning_proposals_context_status
    ON axis_learning_proposals (context_id, status, updated_at DESC)
  `;

  yield* sql`
    CREATE TABLE axis_learning_versions (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL UNIQUE,
      context_id TEXT NOT NULL,
      target_key TEXT NOT NULL,
      version_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (proposal_id) REFERENCES axis_learning_proposals(id)
    )
  `;
  yield* sql`
    CREATE TRIGGER axis_learning_versions_immutable_update
    BEFORE UPDATE ON axis_learning_versions
    BEGIN
      SELECT RAISE(ABORT, 'Axis learning versions are immutable');
    END
  `;
  yield* sql`
    CREATE TRIGGER axis_learning_versions_immutable_delete
    BEFORE DELETE ON axis_learning_versions
    BEGIN
      SELECT RAISE(ABORT, 'Axis learning versions are immutable');
    END
  `;

  yield* sql`
    CREATE TABLE axis_learning_active_versions (
      context_id TEXT NOT NULL,
      target_key TEXT NOT NULL,
      version_id TEXT NOT NULL,
      activated_at TEXT NOT NULL,
      PRIMARY KEY (context_id, target_key),
      FOREIGN KEY (version_id) REFERENCES axis_learning_versions(id)
    )
  `;

  yield* sql`
    CREATE TABLE axis_learning_lifecycle_events (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      proposal_id TEXT,
      version_id TEXT,
      action TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX axis_learning_lifecycle_context_created
    ON axis_learning_lifecycle_events (context_id, created_at, id)
  `;
  yield* sql`
    CREATE TRIGGER axis_learning_lifecycle_immutable_update
    BEFORE UPDATE ON axis_learning_lifecycle_events
    BEGIN
      SELECT RAISE(ABORT, 'Axis learning lifecycle events are immutable');
    END
  `;
  yield* sql`
    CREATE TRIGGER axis_learning_lifecycle_immutable_delete
    BEFORE DELETE ON axis_learning_lifecycle_events
    BEGIN
      SELECT RAISE(ABORT, 'Axis learning lifecycle events are immutable');
    END
  `;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Adds project-qualified Learning keys while preserving legacy context rows. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE axis_learning_proposals
    ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'context'
  `;
  yield* sql`
    ALTER TABLE axis_learning_versions
    ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'context'
  `;
  yield* sql`
    ALTER TABLE axis_learning_lifecycle_events
    ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'context'
  `;

  yield* sql`
    CREATE INDEX axis_learning_proposals_scope_status
    ON axis_learning_proposals (context_id, scope_key, status, updated_at DESC)
  `;
  yield* sql`
    CREATE INDEX axis_learning_versions_scope_target
    ON axis_learning_versions (context_id, scope_key, target_key, created_at DESC)
  `;
  yield* sql`
    CREATE INDEX axis_learning_lifecycle_scope_created
    ON axis_learning_lifecycle_events (context_id, scope_key, created_at, id)
  `;

  yield* sql`
    CREATE TABLE axis_learning_evidence_scoped (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (context_id, scope_key, fingerprint)
    )
  `;
  yield* sql`
    INSERT INTO axis_learning_evidence_scoped
      (id, context_id, scope_key, fingerprint, evidence_json, expires_at, created_at)
    SELECT id, context_id, 'context', fingerprint, evidence_json, expires_at, created_at
    FROM axis_learning_evidence
  `;
  yield* sql`DROP TABLE axis_learning_evidence`;
  yield* sql`
    ALTER TABLE axis_learning_evidence_scoped RENAME TO axis_learning_evidence
  `;
  yield* sql`
    CREATE INDEX axis_learning_evidence_expiry
    ON axis_learning_evidence (expires_at)
  `;
  yield* sql`
    CREATE INDEX axis_learning_evidence_scope
    ON axis_learning_evidence (context_id, scope_key, created_at, id)
  `;

  yield* sql`
    CREATE TABLE axis_learning_active_versions_scoped (
      context_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      target_key TEXT NOT NULL,
      version_id TEXT,
      activated_at TEXT,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (context_id, scope_key, target_key),
      FOREIGN KEY (version_id) REFERENCES axis_learning_versions(id)
    )
  `;
  yield* sql`
    INSERT INTO axis_learning_active_versions_scoped
      (context_id, scope_key, target_key, version_id, activated_at, revision, updated_at)
    SELECT context_id, 'context', target_key, version_id, activated_at, 0, activated_at
    FROM axis_learning_active_versions
  `;
  yield* sql`DROP TABLE axis_learning_active_versions`;
  yield* sql`
    ALTER TABLE axis_learning_active_versions_scoped RENAME TO axis_learning_active_versions
  `;
  yield* sql`
    CREATE INDEX axis_learning_active_versions_scope
    ON axis_learning_active_versions (context_id, scope_key, target_key)
  `;

});

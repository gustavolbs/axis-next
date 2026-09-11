import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("060_AxisLearningProjectScope", (it) => {
  it.effect("preserves populated legacy JSON and keeps cleanup deletion rules", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 59 });

      const legacyEvidenceJson = '{ "legacy": "evidence", "nested": [1, 2], "keep": true }';
      const legacyProposalJson = '{"legacy":"proposal","status":"approved"}';
      const legacyVersionJson = '{ "legacy": "version", "change": { "op": "unknown" } }';
      const legacyLifecycleJson = '{"legacy":"lifecycle","action":"approved"}';
      const now = "2026-09-09T00:00:00.000Z";

      yield* sql`
        INSERT INTO axis_learning_evidence
          (id, context_id, fingerprint, evidence_json, expires_at, created_at)
        VALUES ('legacy-evidence', 'personal', 'legacy-evidence-fingerprint',
          ${legacyEvidenceJson}, '2026-10-09T00:00:00.000Z', ${now})
      `;
      yield* sql`
        INSERT INTO axis_learning_proposals
          (id, context_id, target_key, status, proposal_json, created_at, updated_at)
        VALUES ('legacy-proposal', 'personal', 'workflow:legacy', 'approved',
          ${legacyProposalJson}, ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO axis_learning_versions
          (id, proposal_id, context_id, target_key, version_json, created_at)
        VALUES ('legacy-version', 'legacy-proposal', 'personal', 'workflow:legacy',
          ${legacyVersionJson}, ${now})
      `;
      yield* sql`
        INSERT INTO axis_learning_active_versions
          (context_id, target_key, version_id, activated_at)
        VALUES ('personal', 'workflow:legacy', 'legacy-version', ${now})
      `;
      yield* sql`
        INSERT INTO axis_learning_lifecycle_events
          (id, context_id, proposal_id, version_id, action, event_json, created_at)
        VALUES ('legacy-event', 'personal', 'legacy-proposal', 'legacy-version', 'approved',
          ${legacyLifecycleJson}, ${now})
      `;

      yield* runMigrations();

      const jsonAfterMigration = yield* sql<{
        readonly evidenceJson: string;
        readonly proposalJson: string;
        readonly versionJson: string;
        readonly lifecycleJson: string;
      }>`
        SELECT
          (SELECT evidence_json FROM axis_learning_evidence WHERE id = 'legacy-evidence') AS "evidenceJson",
          (SELECT proposal_json FROM axis_learning_proposals WHERE id = 'legacy-proposal') AS "proposalJson",
          (SELECT version_json FROM axis_learning_versions WHERE id = 'legacy-version') AS "versionJson",
          (SELECT event_json FROM axis_learning_lifecycle_events WHERE id = 'legacy-event') AS "lifecycleJson"
      `;
      assert.deepEqual(jsonAfterMigration[0], {
        evidenceJson: legacyEvidenceJson,
        proposalJson: legacyProposalJson,
        versionJson: legacyVersionJson,
        lifecycleJson: legacyLifecycleJson,
      });

      const migratedScope = yield* sql<{
        readonly evidenceScopeKey: string;
        readonly proposalScopeKey: string;
        readonly versionScopeKey: string;
        readonly lifecycleScopeKey: string;
        readonly revision: number;
        readonly updatedAt: string;
      }>`
        SELECT
          (SELECT scope_key FROM axis_learning_evidence WHERE id = 'legacy-evidence') AS "evidenceScopeKey",
          (SELECT scope_key FROM axis_learning_proposals WHERE id = 'legacy-proposal') AS "proposalScopeKey",
          (SELECT scope_key FROM axis_learning_versions WHERE id = 'legacy-version') AS "versionScopeKey",
          (SELECT scope_key FROM axis_learning_lifecycle_events WHERE id = 'legacy-event') AS "lifecycleScopeKey",
          (SELECT revision FROM axis_learning_active_versions
            WHERE context_id = 'personal' AND target_key = 'workflow:legacy') AS revision,
          (SELECT updated_at FROM axis_learning_active_versions
            WHERE context_id = 'personal' AND target_key = 'workflow:legacy') AS "updatedAt"
      `;
      assert.deepEqual(migratedScope[0], {
        evidenceScopeKey: "context",
        proposalScopeKey: "context",
        versionScopeKey: "context",
        lifecycleScopeKey: "context",
        revision: 0,
        updatedAt: now,
      });

      yield* sql`DELETE FROM axis_learning_active_versions
        WHERE context_id = 'personal' AND target_key = 'workflow:legacy'`;
      assert.equal(
        (yield* Effect.exit(sql`DELETE FROM axis_learning_versions WHERE id = 'legacy-version'`))
          ._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.exit(
          sql`DELETE FROM axis_learning_lifecycle_events WHERE id = 'legacy-event'`,
        ))._tag,
        "Failure",
      );

      yield* sql`UPDATE axis_context_catalog SET catalog_json = '{"contexts":[]}' WHERE singleton = 1`;
      yield* sql`DELETE FROM axis_learning_versions WHERE id = 'legacy-version'`;
      yield* sql`DELETE FROM axis_learning_lifecycle_events WHERE id = 'legacy-event'`;
      const deleted = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM axis_learning_versions
        WHERE id = 'legacy-version'
      `;
      assert.equal(deleted[0]?.count, 0);
    }),
  );

  it.effect("isolates evidence and active revisions by scope", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 59 });
      yield* runMigrations();

      const now = "2026-09-09T00:00:00.000Z";
      const laptop = 'project:["laptop","project-a"]';
      const desktop = 'project:["desktop","project-a"]';
      yield* sql`
        INSERT INTO axis_learning_evidence
          (id, context_id, scope_key, fingerprint, evidence_json, expires_at, created_at)
        VALUES
          ('evidence-context', 'personal', 'context', 'same', '{}', ${now}, ${now}),
          ('evidence-laptop', 'personal', ${laptop}, 'same', '{}', ${now}, ${now}),
          ('evidence-desktop', 'personal', ${desktop}, 'same', '{}', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO axis_learning_active_versions
          (context_id, scope_key, target_key, version_id, revision, updated_at)
        VALUES
          ('personal', 'context', 'workflow:test', NULL, 4, ${now}),
          ('personal', ${laptop}, 'workflow:test', NULL, 7, ${now}),
          ('personal', ${desktop}, 'workflow:test', NULL, 2, ${now})
      `;

      const active = yield* sql<{
        readonly scope_key: string;
        readonly version_id: string | null;
        readonly revision: number;
      }>`
        SELECT scope_key, version_id, revision
        FROM axis_learning_active_versions
        WHERE context_id = 'personal'
        ORDER BY scope_key
      `;
      assert.deepEqual(active, [
        { scope_key: "context", version_id: null, revision: 4 },
        { scope_key: desktop, version_id: null, revision: 2 },
        { scope_key: laptop, version_id: null, revision: 7 },
      ]);

      const duplicateExit = yield* Effect.exit(
        sql`
          INSERT INTO axis_learning_evidence
            (id, context_id, scope_key, fingerprint, evidence_json, expires_at, created_at)
          VALUES ('duplicate', 'personal', ${laptop}, 'same', '{}', ${now}, ${now})
        `,
      );
      assert.equal(duplicateExit._tag, "Failure");

      yield* sql`
        INSERT INTO axis_learning_proposals
          (id, context_id, scope_key, target_key, status, proposal_json, created_at, updated_at)
        VALUES ('proposal-1', 'personal', ${laptop}, 'workflow:test', 'approved', '{}', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO axis_learning_versions
          (id, proposal_id, context_id, scope_key, target_key, version_json, created_at)
        VALUES ('version-1', 'proposal-1', 'personal', ${laptop}, 'workflow:test', '{}', ${now})
      `;
      const immutableVersion = yield* Effect.exit(
        sql`UPDATE axis_learning_versions SET version_json = '{"changed":true}' WHERE id = 'version-1'`,
      );
      assert.equal(immutableVersion._tag, "Failure");

      const immutableLifecycle = yield* Effect.exit(
        sql`
          INSERT INTO axis_learning_lifecycle_events
            (id, context_id, scope_key, proposal_id, version_id, action, event_json, created_at)
          VALUES ('event-1', 'personal', ${laptop}, 'proposal-1', 'version-1', 'approved', '{}', ${now})
        `,
      );
      assert.equal(immutableLifecycle._tag, "Success");
      const lifecycleUpdate = yield* Effect.exit(
        sql`UPDATE axis_learning_lifecycle_events SET action = 'rejected' WHERE id = 'event-1'`,
      );
      assert.equal(lifecycleUpdate._tag, "Failure");
    }),
  );
});

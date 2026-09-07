import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AxisContextCatalog, AxisWorkHubCacheSnapshot } from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  AxisWorkHubCacheStore,
  layer as cacheStoreLayer,
} from "../workHub/AxisWorkHubCacheStore.ts";
import { AxisContextCatalogStore, layer as storeLayer } from "./AxisContextCatalogStore.ts";

const persistence = SqlitePersistenceMemory;
const testLayer = Layer.merge(
  persistence,
  Layer.merge(
    storeLayer.pipe(Layer.provide(persistence)),
    cacheStoreLayer.pipe(Layer.provide(persistence)),
  ),
);
const layer = it.layer(testLayer);
const decodeCatalog = Schema.decodeUnknownSync(AxisContextCatalog);
const decodeCacheSnapshot = Schema.decodeUnknownSync(AxisWorkHubCacheSnapshot);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const seedDependentSchedule = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const activityJson = encodeUnknownJson({
    action: { kind: "workHubSync", sourceIds: ["company_calendar"] },
  });
  yield* sql`
    INSERT INTO axis_scheduled_activities
      (id, context_id, activity_json, enabled, next_run_at, updated_at)
    VALUES
      ('company_sync', 'company_a', ${activityJson}, 1,
       '2026-09-05T08:00:00.000Z', '2026-09-05T00:00:00.000Z')
  `;
  yield* sql`
    INSERT INTO axis_scheduled_activity_runs
      (id, activity_id, run_json, started_at)
    VALUES ('company_sync_run', 'company_sync', '{}', '2026-09-05T08:00:00.000Z')
  `;
});

const seedAgentSchedule = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const activityJson = encodeUnknownJson({
    action: {
      kind: "agentTurn",
      project: { environmentId: "env", projectId: "project_a" },
      provider: { environmentId: "env", instanceId: "codex" },
    },
  });
  yield* sql`
    INSERT INTO axis_scheduled_activities
      (id, context_id, activity_json, enabled, next_run_at, updated_at)
    VALUES
      ('company_agent', 'company_a', ${activityJson}, 1,
       '2026-09-05T08:00:00.000Z', '2026-09-05T00:00:00.000Z')
  `;
});

const seedDependentLearning = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO axis_learning_evidence
      (id, context_id, fingerprint, evidence_json, expires_at, created_at)
    VALUES
      ('company_evidence', 'company_a', 'company-fingerprint', '{}',
       '2026-10-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z')
  `;
  yield* sql`
    INSERT INTO axis_learning_proposals
      (id, context_id, target_key, status, proposal_json, created_at, updated_at)
    VALUES
      ('company_proposal', 'company_a', 'skill:test', 'approved', '{}',
       '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z')
  `;
  yield* sql`
    INSERT INTO axis_learning_versions
      (id, proposal_id, context_id, target_key, version_json, created_at)
    VALUES
      ('company_version', 'company_proposal', 'company_a', 'skill:test', '{}',
       '2026-09-05T00:00:00.000Z')
  `;
  yield* sql`
    INSERT INTO axis_learning_active_versions
      (context_id, target_key, version_id, activated_at)
    VALUES
      ('company_a', 'skill:test', 'company_version', '2026-09-05T00:00:00.000Z')
  `;
  yield* sql`
    INSERT INTO axis_learning_lifecycle_events
      (id, context_id, proposal_id, version_id, action, event_json, created_at)
    VALUES
      ('company_event', 'company_a', 'company_proposal', 'company_version', 'approved', '{}',
       '2026-09-05T00:00:00.000Z')
  `;
});

const seedWorkHubCache = Effect.gen(function* () {
  const catalogs = yield* AxisContextCatalogStore;
  const cache = yield* AxisWorkHubCacheStore;
  const current = yield* catalogs.get;
  const personal = current.catalog.contexts.find((context) => context.kind === "personal")!;
  const initial = yield* catalogs.replace({
    expectedRevision: current.revision,
    catalog: decodeCatalog({
      contexts: [personal],
      projectBindings: [],
      providerOwnerships: [],
      providerAccessGrants: [],
      capabilities: [],
      workHubSources: [],
    }),
  });
  const updated = yield* catalogs.replace({
    expectedRevision: initial.revision,
    catalog: decodeCatalog({
      ...initial.catalog,
      contexts: [
        ...initial.catalog.contexts,
        {
          id: "company_a",
          kind: "company",
          name: "Company A",
          createdAt: initial.updatedAt,
          updatedAt: initial.updatedAt,
        },
      ],
      providerOwnerships: [
        { contextId: "personal", provider: { environmentId: "env", instanceId: "codex" } },
      ],
      providerAccessGrants: [
        {
          id: "company_a_codex",
          ownerContextId: "personal",
          targetContextId: "company_a",
          provider: { environmentId: "env", instanceId: "codex" },
          status: "active",
          createdAt: initial.updatedAt,
          updatedAt: initial.updatedAt,
          revokedAt: null,
        },
      ],
      capabilities: [
        {
          id: "calendar",
          provider: { environmentId: "env", instanceId: "codex" },
          kind: "mcp",
          name: "Calendar",
          enabled: true,
          createdAt: initial.updatedAt,
          updatedAt: initial.updatedAt,
        },
      ],
      workHubSources: [
        {
          id: "company_calendar",
          contextId: "company_a",
          provider: { environmentId: "env", instanceId: "codex" },
          capabilityId: "calendar",
          enabled: true,
          createdAt: initial.updatedAt,
          updatedAt: initial.updatedAt,
        },
      ],
    }),
  });
  yield* cache.replace(
    decodeCacheSnapshot({
      sourceId: "company_calendar",
      contextId: "company_a",
      provider: { environmentId: "env", instanceId: "codex" },
      capabilityId: "calendar",
      items: [],
      refreshedAt: "2026-09-05T00:00:00.000Z",
      expiresAt: "2026-09-05T08:00:00.000Z",
    }),
  );
  return updated;
});

layer("AxisContextCatalogStore", (it) => {
  it.effect("loads legacy fifteen-minute Work Hub sources as eight-hour sources", () =>
    Effect.gen(function* () {
      const store = yield* AxisContextCatalogStore;
      const sql = yield* SqlClient.SqlClient;
      const initial = yield* store.get;
      const catalogJson = encodeUnknownJson({
        ...initial.catalog,
        workHubSources: [
          {
            id: "legacy_calendar",
            contextId: "personal",
            provider: { environmentId: "env", instanceId: "codex" },
            capabilityId: "calendar",
            enabled: true,
            cacheTtlSeconds: 15 * 60,
            createdAt: initial.updatedAt,
            updatedAt: initial.updatedAt,
          },
        ],
      });
      yield* sql`UPDATE axis_context_catalog SET catalog_json = ${catalogJson} WHERE singleton = 1`;

      const loaded = yield* store.get;

      assert.equal(loaded.catalog.workHubSources[0]?.cacheTtlSeconds, 8 * 60 * 60);
      const restoredCatalogJson = encodeUnknownJson(initial.catalog);
      yield* sql`
        UPDATE axis_context_catalog
        SET catalog_json = ${restoredCatalogJson}
        WHERE singleton = 1
      `;
    }),
  );

  it.effect("persists valid revisions and rejects stale or invalid replacements", () =>
    Effect.gen(function* () {
      const store = yield* AxisContextCatalogStore;
      const initial = yield* store.get;

      assert.equal(initial.revision, 0);
      assert.equal(initial.catalog.contexts.length, 1);
      assert.equal(initial.catalog.contexts[0]?.kind, "personal");
      const company = {
        id: "company_a",
        kind: "company",
        name: "Company A",
        createdAt: initial.updatedAt,
        updatedAt: initial.updatedAt,
      } as const;
      const catalog = decodeCatalog({
        ...initial.catalog,
        contexts: [...initial.catalog.contexts, company],
      });

      const updated = yield* store.replace({ expectedRevision: 0, catalog });

      assert.equal(updated.revision, 1);
      assert.deepEqual(
        updated.catalog.contexts.map((context) => context.name),
        ["Personal", "Company A"],
      );

      const conflict = yield* store
        .replace({ expectedRevision: 0, catalog: initial.catalog })
        .pipe(Effect.flip);

      assert.equal(conflict._tag, "AxisContextCatalogConflictError");
      if (conflict._tag === "AxisContextCatalogConflictError") {
        assert.equal(conflict.actualRevision, 1);
      }
      assert.equal((yield* store.get).revision, 1);
      const invalid = decodeCatalog({ contexts: [] });

      const error = yield* store
        .replace({ expectedRevision: 1, catalog: invalid })
        .pipe(Effect.flip);

      assert.equal(error._tag, "AxisContextCatalogValidationError");
      if (error._tag === "AxisContextCatalogValidationError") {
        assert.deepEqual(
          error.issues.map((issue) => issue.code),
          ["personal_context_count"],
        );
      }
      assert.equal((yield* store.get).revision, 1);
    }),
  );

  for (const removal of ["source", "capability", "context"] as const) {
    it.effect(`purges cached snapshots and schedules when their ${removal} is removed`, () =>
      Effect.gen(function* () {
        const store = yield* AxisContextCatalogStore;
        const sql = yield* SqlClient.SqlClient;
        const seeded = yield* seedWorkHubCache;
        yield* seedDependentSchedule;
        const catalog = decodeCatalog({
          ...seeded.catalog,
          contexts:
            removal === "context"
              ? seeded.catalog.contexts.filter((context) => context.id !== "company_a")
              : seeded.catalog.contexts,
          providerAccessGrants: removal === "context" ? [] : seeded.catalog.providerAccessGrants,
          capabilities: removal === "capability" ? [] : seeded.catalog.capabilities,
          workHubSources: [],
        });

        yield* store.replace({ expectedRevision: seeded.revision, catalog });

        const rows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM axis_work_hub_cache
        `;
        assert.equal(rows[0]?.count, 0);
        const activities = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM axis_scheduled_activities
        `;
        const runs = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM axis_scheduled_activity_runs
        `;
        assert.equal(activities[0]?.count, 0);
        assert.equal(runs[0]?.count, 0);
      }),
    );
  }

  it.effect("purges every learning record when its context is removed", () =>
    Effect.gen(function* () {
      const store = yield* AxisContextCatalogStore;
      const sql = yield* SqlClient.SqlClient;
      const seeded = yield* seedWorkHubCache;
      yield* seedDependentLearning;
      const catalog = decodeCatalog({
        ...seeded.catalog,
        contexts: seeded.catalog.contexts.filter((context) => context.id !== "company_a"),
        providerAccessGrants: [],
        workHubSources: [],
      });

      yield* store.replace({ expectedRevision: seeded.revision, catalog });

      const rows = yield* sql<{
        readonly evidence: number;
        readonly proposals: number;
        readonly versions: number;
        readonly activeVersions: number;
        readonly lifecycle: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM axis_learning_evidence
           WHERE context_id = 'company_a') AS evidence,
          (SELECT COUNT(*) FROM axis_learning_proposals
           WHERE context_id = 'company_a') AS proposals,
          (SELECT COUNT(*) FROM axis_learning_versions
           WHERE context_id = 'company_a') AS versions,
          (SELECT COUNT(*) FROM axis_learning_active_versions
           WHERE context_id = 'company_a') AS "activeVersions",
          (SELECT COUNT(*) FROM axis_learning_lifecycle_events
           WHERE context_id = 'company_a') AS lifecycle
      `;
      assert.deepEqual(rows[0], {
        evidence: 0,
        proposals: 0,
        versions: 0,
        activeVersions: 0,
        lifecycle: 0,
      });
    }),
  );

  for (const removal of ["project binding", "provider grant"] as const) {
    it.effect(`purges scheduled agent work when its ${removal} is removed`, () =>
      Effect.gen(function* () {
        const store = yield* AxisContextCatalogStore;
        const sql = yield* SqlClient.SqlClient;
        const seeded = yield* seedWorkHubCache;
        const withProject = yield* store.replace({
          expectedRevision: seeded.revision,
          catalog: decodeCatalog({
            ...seeded.catalog,
            projectBindings: [
              {
                contextId: "company_a",
                project: { environmentId: "env", projectId: "project_a" },
              },
            ],
          }),
        });
        yield* seedAgentSchedule;
        const catalog = decodeCatalog({
          ...withProject.catalog,
          projectBindings: removal === "project binding" ? [] : withProject.catalog.projectBindings,
          providerAccessGrants:
            removal === "provider grant"
              ? withProject.catalog.providerAccessGrants.map((grant) => ({
                  ...grant,
                  status: "revoked" as const,
                  revokedAt: withProject.updatedAt,
                }))
              : withProject.catalog.providerAccessGrants,
          workHubSources: removal === "provider grant" ? [] : withProject.catalog.workHubSources,
        });

        yield* store.replace({ expectedRevision: withProject.revision, catalog });

        const rows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM axis_scheduled_activities WHERE id = 'company_agent'
        `;
        assert.equal(rows[0]?.count, 0);
      }),
    );
  }

  it.effect("rolls back the catalog and cache when dependent cleanup fails", () =>
    Effect.gen(function* () {
      const store = yield* AxisContextCatalogStore;
      const sql = yield* SqlClient.SqlClient;
      const seeded = yield* seedWorkHubCache;
      yield* seedDependentSchedule;
      yield* sql`
        CREATE TRIGGER reject_schedule_cleanup
        BEFORE DELETE ON axis_scheduled_activities
        BEGIN
          SELECT RAISE(ABORT, 'test cleanup failure');
        END
      `;
      const catalog = decodeCatalog({ ...seeded.catalog, workHubSources: [] });

      const exit = yield* Effect.exit(
        store.replace({ expectedRevision: seeded.revision, catalog }),
      );

      assert.equal(exit._tag, "Failure");
      assert.equal((yield* store.get).revision, seeded.revision);
      const cacheRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM axis_work_hub_cache
      `;
      const activities = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM axis_scheduled_activities
      `;
      assert.equal(cacheRows[0]?.count, 1);
      assert.equal(activities[0]?.count, 1);
      yield* sql`DROP TRIGGER reject_schedule_cleanup`;
    }),
  );
});

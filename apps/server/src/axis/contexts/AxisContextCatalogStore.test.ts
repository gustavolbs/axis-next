import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AxisContextCatalog } from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AxisContextCatalogStore, layer as storeLayer } from "./AxisContextCatalogStore.ts";

const testLayer = Layer.merge(
  SqlitePersistenceMemory,
  storeLayer.pipe(Layer.provide(SqlitePersistenceMemory)),
);
const layer = it.layer(testLayer);
const decodeCatalog = Schema.decodeUnknownSync(AxisContextCatalog);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

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
});

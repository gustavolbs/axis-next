import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AxisContextCatalog } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const decodeCatalogJson = Schema.decodeUnknownEffect(Schema.fromJsonString(AxisContextCatalog));

layer("048_AxisContextCatalog", (it) => {
  it.effect("creates a revisioned catalog with the Personal context", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* runMigrations({ toMigrationInclusive: 48 });

      const [row] = yield* sql<{
        readonly revision: number;
        readonly catalogJson: string;
        readonly updatedAt: string;
      }>`
        SELECT
          revision,
          catalog_json AS "catalogJson",
          updated_at AS "updatedAt"
        FROM axis_context_catalog
        WHERE singleton = 1
      `;
      const catalog = yield* decodeCatalogJson(row?.catalogJson);

      assert.equal(row?.revision, 0);
      assert.match(row?.updatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(
        catalog.contexts.map(({ id, kind, name }) => ({ id, kind, name })),
        [{ id: "personal", kind: "personal", name: "Personal" }],
      );
      assert.deepEqual(catalog.providerOwnerships, []);
      assert.deepEqual(catalog.capabilities, []);
    }),
  );
});

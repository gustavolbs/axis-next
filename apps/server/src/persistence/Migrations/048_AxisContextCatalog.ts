import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AxisContextCatalog } from "@t3tools/contracts";

const encodeCatalogJson = Schema.encodeUnknownEffect(Schema.fromJsonString(AxisContextCatalog));

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  const initialCatalog = yield* encodeCatalogJson({
    contexts: [
      {
        id: "personal",
        kind: "personal",
        name: "Personal",
        createdAt: now,
        updatedAt: now,
      },
    ],
    providerOwnerships: [],
    providerAccessGrants: [],
    capabilities: [],
  });

  yield* sql`
    CREATE TABLE axis_context_catalog (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      catalog_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO axis_context_catalog (singleton, revision, catalog_json, updated_at)
    VALUES (1, 0, ${initialCatalog}, ${now})
  `;
});

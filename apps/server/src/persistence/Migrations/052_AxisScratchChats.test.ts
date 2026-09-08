import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("052_AxisScratchChats", (it) => {
  it.effect("creates the scratch chats table with the expected index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });

      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'axis_scratch_chats'
        UNION ALL
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'axis_scratch_chats_env_updated'
        ORDER BY name
      `;

      assert.deepEqual(rows, [
        { name: "axis_scratch_chats" },
        { name: "axis_scratch_chats_env_updated" },
      ]);
    }),
  );
});

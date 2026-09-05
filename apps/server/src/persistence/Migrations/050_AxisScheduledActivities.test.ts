import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_AxisScheduledActivities", (it) => {
  it.effect("creates activity and run history tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });

      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('axis_scheduled_activities', 'axis_scheduled_activity_runs')
        ORDER BY name
      `;

      assert.deepEqual(rows, [
        { name: "axis_scheduled_activities" },
        { name: "axis_scheduled_activity_runs" },
      ]);
    }),
  );
});

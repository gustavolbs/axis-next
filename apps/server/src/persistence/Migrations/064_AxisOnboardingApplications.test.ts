import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import Migration0064 from "./064_AxisOnboardingApplications.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("064_AxisOnboardingApplications", (it) => {
  it.effect("creates a scoped apply ledger with a run foreign key", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });
      yield* Migration0064;

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('axis_onboarding_applications') ORDER BY cid
      `;
      assert.deepEqual(
        columns.map((column) => column.name),
        [
          "context_id",
          "scope_key",
          "run_id",
          "command_id",
          "request_digest",
          "response_json",
          "created_at",
        ],
      );
      const foreignKeys = yield* sql<{ readonly table: string; readonly on_delete: string }>`
        SELECT "table", on_delete FROM pragma_foreign_key_list('axis_onboarding_applications')
      `;
      assert.equal(foreignKeys.length, 3);
      assert.isTrue(
        foreignKeys.every(
          (foreignKey) =>
            foreignKey.table === "axis_onboarding_runs" && foreignKey.on_delete === "CASCADE",
        ),
      );
    }),
  );
});

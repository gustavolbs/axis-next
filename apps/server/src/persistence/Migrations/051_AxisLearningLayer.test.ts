import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("051_AxisLearningLayer", (it) => {
  it.effect("creates learning tables and enforces immutable versions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 51 });
      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'axis_learning_%'
        ORDER BY name
      `;
      assert.deepEqual(
        rows.map((row) => row.name),
        [
          "axis_learning_active_versions",
          "axis_learning_evidence",
          "axis_learning_lifecycle_events",
          "axis_learning_proposals",
          "axis_learning_versions",
        ],
      );

      yield* sql`INSERT INTO axis_learning_proposals
        (id, context_id, target_key, status, proposal_json, created_at, updated_at)
        VALUES ('proposal_1', 'personal', 'skill:test', 'approved', '{}', '2026-09-05', '2026-09-05')`;
      yield* sql`INSERT INTO axis_learning_versions
        (id, proposal_id, context_id, target_key, version_json, created_at)
        VALUES ('version_1', 'proposal_1', 'personal', 'skill:test', '{}', '2026-09-05')`;
      const updateExit = yield* Effect.exit(
        sql`UPDATE axis_learning_versions SET version_json = '{"changed":true}' WHERE id = 'version_1'`,
      );
      assert.isTrue(updateExit._tag === "Failure");
      const deleteExit = yield* Effect.exit(
        sql`DELETE FROM axis_learning_versions WHERE id = 'version_1'`,
      );
      assert.isTrue(deleteExit._tag === "Failure");

      yield* sql`INSERT INTO axis_learning_lifecycle_events
        (id, context_id, proposal_id, version_id, action, event_json, created_at)
        VALUES ('event_1', 'personal', 'proposal_1', 'version_1', 'approved', '{}', '2026-09-05')`;
      const lifecycleUpdateExit = yield* Effect.exit(
        sql`UPDATE axis_learning_lifecycle_events SET action = 'rejected' WHERE id = 'event_1'`,
      );
      assert.isTrue(lifecycleUpdateExit._tag === "Failure");
    }),
  );
});

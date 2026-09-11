import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("066_AxisVerificationEvidence", (it) => {
  it.effect("creates the table, applies the index, and stores an evidence row", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 65 });
      yield* runMigrations();

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'axis_verification_evidence'
      `;
      assert.equal(tables.length, 1);

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'axis_verification_evidence'
      `;
      const indexNames = indexes.map((row) => row.name);
      assert.includeMembers(indexNames, [
        "axis_verification_evidence_task_step",
        "sqlite_autoindex_axis_verification_evidence_1",
      ]);

      const now = "2026-09-11T00:00:00.000Z";
      yield* sql`
        INSERT INTO axis_verification_evidence (
          context_id, scope_key, task_id, step_id, command_id,
          outcome, command, exit_code, observed_at, observed_revision,
          covered_files_json, summary, source, reason, created_at
        )
        VALUES (
          'ctx', 'project:["env","proj"]', 'task-1', 'step-1', 'cmd-1',
          'passed', 'vp test run apps/server/src', 0, ${now}, 1,
          '["a","b"]', 'All tests passed.', 'auto', NULL, ${now}
        )
      `;
      const stored = yield* sql<{
        readonly outcome: string;
        readonly summary: string;
        readonly coveredFilesJson: string;
      }>`
        SELECT outcome, summary, covered_files_json AS coveredFilesJson
        FROM axis_verification_evidence
        WHERE context_id = 'ctx'
      `;
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.outcome, "passed");
      assert.equal(stored[0]?.summary, "All tests passed.");
      assert.equal(stored[0]?.coveredFilesJson, '["a","b"]');
    }),
  );
});

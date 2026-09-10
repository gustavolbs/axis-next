import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("062_AxisOnboardingRuns", (it) => {
  it.effect("adds scoped run storage and command idempotency without provider replicas", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 61 });
      const executed = yield* runMigrations({ toMigrationInclusive: 62 });
      const scopedKey = 'project:["laptop","project-a"]';

      assert.deepEqual(executed, [[62, "AxisOnboardingRuns"]]);
      const runColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('axis_onboarding_runs') ORDER BY cid
      `;
      assert.deepEqual(
        runColumns.map((column) => column.name),
        [
          "run_id",
          "context_id",
          "environment_id",
          "project_id",
          "scope_key",
          "thread_id",
          "turn_id",
          "status",
          "run_json",
          "started_at",
          "finished_at",
          "updated_at",
        ],
      );
      assert.isFalse(runColumns.some((column) => /message|provider|session/i.test(column.name)));

      const commandColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('axis_onboarding_commands') ORDER BY cid
      `;
      assert.deepEqual(
        commandColumns.map((column) => column.name),
        [
          "context_id",
          "scope_key",
          "run_id",
          "command_id",
          "action",
          "request_digest",
          "created_at",
        ],
      );

      yield* sql`
        INSERT INTO axis_onboarding_runs (
          run_id, context_id, environment_id, project_id, scope_key,
          thread_id, turn_id, status, run_json, started_at, finished_at, updated_at
        ) VALUES (
          'run-a', 'company', 'laptop', 'project-a', ${scopedKey},
          'thread-a', 'turn-a', 'running', '{}', '2026-09-10T00:00:00.000Z', NULL,
          '2026-09-10T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO axis_onboarding_commands
          (context_id, scope_key, run_id, command_id, action, request_digest, created_at)
        VALUES (
          'company', ${scopedKey}, 'run-a',
          'command-a', 'start', 'digest-a', '2026-09-10T00:00:00.000Z'
        )
      `;
      const duplicate = yield* Effect.exit(sql`
        INSERT INTO axis_onboarding_commands
          (context_id, scope_key, run_id, command_id, action, request_digest, created_at)
        VALUES (
          'company', ${scopedKey}, 'run-a',
          'command-a', 'start', 'digest-b', '2026-09-10T00:00:00.000Z'
        )
      `);
      assert.equal(duplicate._tag, "Failure");
    }),
  );
});

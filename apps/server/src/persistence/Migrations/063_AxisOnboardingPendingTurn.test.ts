import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("063_AxisOnboardingPendingTurn", (it) => {
  it.effect("preserves runs and retry receipts while allowing an unacknowledged turn", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* sql`INSERT INTO axis_onboarding_runs VALUES ('run', 'company', 'env', 'project', 'scope', 'thread', 'turn', 'completed', '{"legacy":true}', '2026-09-10', '2026-09-10', '2026-09-10')`;
      yield* sql`INSERT INTO axis_onboarding_commands VALUES ('company', 'scope', 'run', 'command', 'start', 'digest', '2026-09-10')`;
      yield* runMigrations({ toMigrationInclusive: 63 });
      const before = yield* sql`SELECT turn_id, run_json FROM axis_onboarding_runs`;
      assert.deepEqual(before, [{ turn_id: "turn", run_json: '{"legacy":true}' }]);
      const receipts = yield* sql`SELECT command_id, request_digest FROM axis_onboarding_commands`;
      assert.deepEqual(receipts, [{ command_id: "command", request_digest: "digest" }]);
      yield* sql`UPDATE axis_onboarding_runs SET turn_id = NULL, status = 'running', finished_at = NULL`;
      assert.deepEqual(yield* sql`SELECT turn_id FROM axis_onboarding_runs`, [{ turn_id: null }]);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      yield* sql`DELETE FROM axis_onboarding_runs`;
      assert.deepEqual(yield* sql`SELECT * FROM axis_onboarding_commands`, []);
    }),
  );
});

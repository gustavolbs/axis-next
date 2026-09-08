import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("056_AxisContextCleanup", (it) => {
  it.effect("keeps learning immutable while its context exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* sql`
        INSERT INTO axis_learning_proposals
          (id, context_id, target_key, status, proposal_json, created_at, updated_at)
        VALUES ('proposal_1', 'personal', 'skill:test', 'approved', '{}', '2026-09-05', '2026-09-05')
      `;
      yield* sql`
        INSERT INTO axis_learning_versions
          (id, proposal_id, context_id, target_key, version_json, created_at)
        VALUES ('version_1', 'proposal_1', 'personal', 'skill:test', '{}', '2026-09-05')
      `;
      yield* sql`
        INSERT INTO axis_learning_lifecycle_events
          (id, context_id, proposal_id, version_id, action, event_json, created_at)
        VALUES ('event_1', 'personal', 'proposal_1', 'version_1', 'approved', '{}', '2026-09-05')
      `;

      assert.equal((yield* Effect.exit(sql`DELETE FROM axis_learning_versions`))._tag, "Failure");
      assert.equal(
        (yield* Effect.exit(sql`DELETE FROM axis_learning_lifecycle_events`))._tag,
        "Failure",
      );
    }),
  );
});

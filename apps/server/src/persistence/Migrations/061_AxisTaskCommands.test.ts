import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("061_AxisTaskCommands", (it) => {
  it.effect("scopes command idempotency by physical scope and thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* runMigrations();

      const commandId = "command-shared";
      yield* sql`
        INSERT INTO axis_task_commands
          (context_id, scope_key, thread_id, command_id, task_id, request_digest, created_at)
        VALUES
          ('company', 'project:["laptop","project-a"]', 'thread', ${commandId}, 'task-a', 'digest-a', '2026-09-09T00:00:00.000Z'),
          ('company', 'project:["desktop","project-a"]', 'thread', ${commandId}, 'task-b', 'digest-b', '2026-09-09T00:00:00.000Z')
      `;

      const duplicate = yield* Effect.exit(sql`
        INSERT INTO axis_task_commands
          (context_id, scope_key, thread_id, command_id, task_id, request_digest, created_at)
        VALUES
          ('company', 'project:["laptop","project-a"]', 'thread', ${commandId}, 'task-c', 'digest-c', '2026-09-09T00:00:00.000Z')
      `);

      assert.equal(duplicate._tag, "Failure");
      assert.deepEqual(
        yield* sql<{ readonly task_id: string }>`
          SELECT task_id FROM axis_task_commands
          WHERE command_id = ${commandId}
          ORDER BY scope_key
        `,
        [{ task_id: "task-b" }, { task_id: "task-a" }],
      );
    }),
  );
});

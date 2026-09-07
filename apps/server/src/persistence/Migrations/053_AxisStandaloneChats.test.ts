import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.effect("preserves legacy chat data and allows standalone rows", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 52 });
    yield* sql`INSERT INTO axis_scratch_chats VALUES ('old', 'env', '{"title":"Existing"}', 'project', 'session', NULL, NULL, '2026-09-07')`;
    yield* runMigrations({ toMigrationInclusive: 53 });
    yield* sql`INSERT INTO axis_scratch_chats VALUES ('new', 'env', '{}', NULL, 'new-session', NULL, NULL, '2026-09-07')`;
    const rows = yield* sql<{
      id: string;
      backing_project_id: string | null;
      backing_thread_id: string;
      scratch_json: string;
    }>`
    SELECT id, backing_project_id, backing_thread_id, scratch_json FROM axis_scratch_chats ORDER BY id
  `;
    assert.deepEqual(rows, [
      { id: "new", backing_project_id: null, backing_thread_id: "new-session", scratch_json: "{}" },
      {
        id: "old",
        backing_project_id: "project",
        backing_thread_id: "session",
        scratch_json: '{"title":"Existing"}',
      },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

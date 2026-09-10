import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect("isolates profiles and task extensions by physical project scope", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const databasePath = path.join(directory, "state.sqlite");
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* runMigrations();

      const now = "2026-09-09T00:00:00.000Z";
      const firstScope = 'project:["laptop","project-a"]';
      const secondScope = 'project:["desktop","project-a"]';
      yield* sql`
        INSERT INTO axis_project_profiles (
          context_id, environment_id, project_id, scope_key, revision,
          profile_json, created_at, updated_at
        ) VALUES (
          'company_a', 'laptop', 'project-a', ${firstScope}, 0,
          '{"title":"Checkout"}', ${now}, ${now}
        ), (
          'company_a', 'desktop', 'project-a', ${secondScope}, 0,
          '{"title":"Checkout"}', ${now}, ${now}
        )
      `;
      yield* sql`
        INSERT INTO axis_task_extensions (
          id, context_id, environment_id, project_id, scope_key, thread_id,
          task_json, created_at, updated_at
        ) VALUES (
          'task-a', 'company_a', 'laptop', 'project-a', ${firstScope}, 'thread-a',
          '{"threadId":"thread-a","title":"Checkout"}', ${now}, ${now}
        ), (
          'task-b', 'company_a', 'desktop', 'project-a', ${secondScope}, 'thread-b',
          '{"threadId":"thread-b","title":"Checkout"}', ${now}, ${now}
        )
      `;

      const profiles = yield* sql<{
        readonly environment_id: string;
        readonly project_id: string;
        readonly scope_key: string;
      }>`
        SELECT environment_id, project_id, scope_key
        FROM axis_project_profiles
        WHERE context_id = 'company_a'
        ORDER BY scope_key
      `;
      assert.deepEqual(profiles, [
        { environment_id: "desktop", project_id: "project-a", scope_key: secondScope },
        { environment_id: "laptop", project_id: "project-a", scope_key: firstScope },
      ]);

      const taskColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('axis_task_extensions') ORDER BY cid
      `;
      assert.deepEqual(
        taskColumns.map((column) => column.name),
        [
          "id",
          "context_id",
          "environment_id",
          "project_id",
          "scope_key",
          "thread_id",
          "task_json",
          "created_at",
          "updated_at",
          "revision",
        ],
      );
      assert.equal(
        taskColumns.some((column) => column.name === "messages_json"),
        false,
      );
      assert.equal(
        taskColumns.some((column) => column.name === "events_json"),
        false,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

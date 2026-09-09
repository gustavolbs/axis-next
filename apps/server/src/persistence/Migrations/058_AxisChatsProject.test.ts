import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";
import { OrchestrationEvent, OrchestrationProjectShell } from "@t3tools/contracts";
import { runMigrations } from "../Migrations.ts";
import { createEmptyReadModel, projectEvent } from "../../orchestration/projector.ts";
import { AXIS_CHATS_PROJECT_ID } from "../../axis/chats/AxisChats.ts";

const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeProject = Schema.decodeUnknownEffect(OrchestrationProjectShell);

it.effect(
  "moves existing chats without losing messages, archive state or resume cursors, including on replay",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs
        .makeTempDirectoryScoped()
        .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
      const now = "2026-09-08T00:00:00.000Z";
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 57 });
        const append = (type: string, payload: object, version: number) => sql`
        INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)
        VALUES (${`seed-${version}`}, 'thread', 'chat', ${version}, ${type}, ${now}, NULL, NULL, NULL, 'system', ${JSON.stringify(payload)}, '{}')`;
        yield* append(
          "thread.created",
          {
            threadId: "chat",
            projectId: null,
            title: "My chat",
            modelSelection: { instanceId: "codex", model: "auto" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
          1,
        );
        yield* append(
          "thread.message-sent",
          {
            threadId: "chat",
            messageId: "message",
            role: "assistant",
            text: "Preserved answer",
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
          2,
        );
        yield* append("thread.archived", { threadId: "chat", archivedAt: now, updatedAt: now }, 3);
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, archived_at, pinned_at)
        VALUES ('chat', NULL, 'My chat', ${now}, ${now}, ${now}, ${now})`;
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES ('coding-thread', 'coding-project', 'Code', ${now}, ${now})`;
        yield* sql`INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, provider_instance_id, runtime_mode, status,
        last_seen_at, resume_cursor_json, runtime_payload_json)
        VALUES ('chat', 'codex', 'codex', 'codex', 'full-access', 'stopped', ${now}, '{"threadId":"native-chat"}', '{"cwd":"/old/workspace"}')`;
        yield* runMigrations();
        yield* runMigrations();
        const projection =
          yield* sql`SELECT project_id, archived_at, pinned_at FROM projection_threads WHERE thread_id = 'chat'`;
        assert.deepEqual(projection, [
          { project_id: AXIS_CHATS_PROJECT_ID, archived_at: now, pinned_at: now },
        ]);
        const coding =
          yield* sql`SELECT project_id, runtime_mode FROM projection_threads WHERE thread_id = 'coding-thread'`;
        assert.deepEqual(coding, [{ project_id: "coding-project", runtime_mode: "full-access" }]);
        const binding =
          yield* sql`SELECT runtime_mode, resume_cursor_json, json_extract(runtime_payload_json, '$.cwd') AS cwd
        FROM provider_session_runtime WHERE thread_id = 'chat'`;
        assert.deepEqual(binding, [
          {
            runtime_mode: "approval-required",
            resume_cursor_json: '{"threadId":"native-chat"}',
            cwd: path.join(directory, "chats", "chat"),
          },
        ]);
        const rows = yield* sql<{
          sequence: number;
          event_id: string;
          aggregate_kind: string;
          stream_id: string;
          event_type: string;
          payload_json: string;
        }>`
        SELECT sequence, event_id, aggregate_kind, stream_id, event_type, payload_json FROM orchestration_events ORDER BY sequence`;
        assert.equal(rows.length, 5);
        assert.equal(rows.at(-1)?.event_type, "thread.meta-updated");
        let replayed = createEmptyReadModel(now);
        for (const row of rows) {
          const event = yield* decodeEvent({
            sequence: row.sequence,
            eventId: row.event_id,
            aggregateKind: row.aggregate_kind,
            aggregateId: row.stream_id,
            occurredAt: now,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: row.event_type,
            payload: yield* decodeJson(row.payload_json),
          });
          replayed = yield* projectEvent(replayed, event);
        }
        assert.equal(replayed.threads[0]?.projectId, AXIS_CHATS_PROJECT_ID);
        assert.equal(replayed.threads[0]?.archivedAt, now);
        assert.equal(replayed.threads[0]?.messages[0]?.text, "Preserved answer");
        assert.equal(replayed.threads[0]?.runtimeMode, "approval-required");
        const project = yield* decodeProject(replayed.projects[0]);
        assert.equal(project.workspaceRoot, path.join(directory, "chats"));
        assert.equal(project.title, "Chats");
      }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") })),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

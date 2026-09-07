import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";
import {
  AxisScratchChat,
  ThreadCreatedPayload,
  ThreadMessageSentPayload,
} from "@t3tools/contracts";
import { runMigrations } from "../Migrations.ts";

it.effect("imports standalone history as replayable events and keeps original files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const now = "2026-09-07T00:00:00.000Z";
    const chat = {
      id: "chat",
      environmentId: "environment",
      title: "Existing chat",
      modelSelection: { instanceId: "codex", model: "auto" },
      providerInstanceId: "codex",
      runtimeMode: "approval-required",
      interactionMode: "default",
      contextId: null,
      backingProjectId: null,
      backingThreadId: "session",
      lastMessagePreview: "Answer",
      messageCount: 2,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      archivedAt: now,
    };
    const messages = [
      { id: "user-message", role: "user", text: "Question" },
      { id: "assistant-message", role: "assistant", text: "Answer" },
    ].map((message, turnIndex) => ({
      ...message,
      chatId: "chat",
      authorName: null,
      createdAt: now,
      turnId: null,
      turnIndex,
      streaming: false,
    }));
    const logPath = path.join(directory, "scratch", "chat.jsonl");
    yield* fs.makeDirectory(path.dirname(logPath));
    const original = messages.map((message) => JSON.stringify(message)).join("\n");
    yield* fs.writeFileString(logPath, original);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, pinned_at)
        VALUES ('existing-thread', 'existing-project', 'Existing project thread', ${now}, ${now}, ${now})`;
      const chatJson = yield* Schema.encodeEffect(Schema.fromJsonString(AxisScratchChat))(
        yield* Schema.decodeUnknownEffect(AxisScratchChat)(chat),
      );
      yield* sql`INSERT INTO axis_scratch_chats VALUES ('chat', 'environment', ${chatJson}, NULL, 'session', ${now}, ${now}, ${now})`;
      yield* runMigrations();
      const preserved =
        yield* sql`SELECT thread_id, project_id, pinned_at FROM projection_threads WHERE thread_id = 'existing-thread'`;
      assert.deepEqual(preserved, [
        { thread_id: "existing-thread", project_id: "existing-project", pinned_at: now },
      ]);
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at) VALUES ('new-chat', NULL, 'New chat', ${now}, ${now})`;
      const events = yield* sql<{
        event_type: string;
        payload_json: string;
      }>`SELECT event_type, payload_json FROM orchestration_events ORDER BY sequence`;
      assert.deepEqual(
        events.map((event) => event.event_type),
        ["thread.created", "thread.message-sent", "thread.message-sent", "thread.archived"],
      );
      const created = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ThreadCreatedPayload),
      )(events[0]!.payload_json);
      const answer = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ThreadMessageSentPayload),
      )(events[2]!.payload_json);
      assert.equal(created.projectId, null);
      assert.equal(answer.text, "Answer");
      yield* runMigrations();
      const count = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_events`;
      assert.equal(count[0]!.count, 4);
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") })),
    );
    assert.equal(yield* fs.readFileString(logPath), original);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

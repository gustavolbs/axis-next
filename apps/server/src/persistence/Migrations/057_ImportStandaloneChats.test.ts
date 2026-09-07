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
  AxisScratchChatMessage,
  MessageId,
  OrchestrationEvent,
  ThreadArchivedPayload,
  ThreadCreatedPayload,
  ThreadMessageSentPayload,
} from "@t3tools/contracts";
import { runMigrations } from "../Migrations.ts";
import { createEmptyReadModel, projectEvent } from "../../orchestration/projector.ts";

const decodeChat = Schema.decodeUnknownEffect(AxisScratchChat);
const encodeChatJson = Schema.encodeEffect(Schema.fromJsonString(AxisScratchChat));
const decodeMessage = Schema.decodeUnknownEffect(AxisScratchChatMessage);
const encodeMessageJson = Schema.encodeEffect(Schema.fromJsonString(AxisScratchChatMessage));
const decodeCreatedPayloadJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ThreadCreatedPayload),
);
const encodeCreatedPayloadJson = Schema.encodeEffect(Schema.fromJsonString(ThreadCreatedPayload));
const decodeMessagePayloadJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ThreadMessageSentPayload),
);
const encodeMessagePayloadJson = Schema.encodeEffect(
  Schema.fromJsonString(ThreadMessageSentPayload),
);
const decodeArchivedPayloadJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ThreadArchivedPayload),
);
const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);

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
      const chatJson = yield* encodeChatJson(yield* decodeChat(chat));
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
      const created = yield* decodeCreatedPayloadJson(events[0]!.payload_json);
      const answer = yield* decodeMessagePayloadJson(events[2]!.payload_json);
      assert.equal(created.projectId, null);
      assert.equal(answer.text, "Answer");
      let replayed = createEmptyReadModel(now);
      for (const event of events) {
        const payload =
          event.event_type === "thread.created"
            ? yield* decodeCreatedPayloadJson(event.payload_json)
            : event.event_type === "thread.message-sent"
              ? yield* decodeMessagePayloadJson(event.payload_json)
              : yield* decodeArchivedPayloadJson(event.payload_json);
        const decoded = yield* decodeEvent({
          sequence: events.indexOf(event) + 1,
          eventId: `replay-${events.indexOf(event)}`,
          aggregateKind: "thread",
          aggregateId: "session",
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: event.event_type,
          payload,
        });
        replayed = yield* projectEvent(replayed, decoded);
      }
      const replayedThread = replayed.threads.find((thread) => thread.id === "session");
      assert.equal(replayedThread?.projectId, null);
      assert.equal(replayedThread?.archivedAt, now);
      assert.deepEqual(
        replayedThread?.messages.map((entry) => entry.text),
        ["Question", "Answer"],
      );
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

it.effect(
  "detaches an existing backing thread and skips messages already in its event stream",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const now = "2026-09-07T00:00:00.000Z";
      const chat = yield* decodeChat({
        id: "existing-chat",
        environmentId: "environment",
        title: "Existing chat",
        modelSelection: { instanceId: "codex", model: "auto" },
        providerInstanceId: "codex",
        runtimeMode: "approval-required",
        interactionMode: "default",
        contextId: null,
        backingProjectId: "existing-project",
        backingThreadId: "existing-thread",
        lastMessagePreview: "Already imported",
        messageCount: 1,
        createdAt: now,
        updatedAt: now,
        lastMessageAt: now,
        archivedAt: null,
      });
      const message = yield* decodeMessage({
        id: "existing-message",
        chatId: "existing-chat",
        role: "user" as const,
        authorName: null,
        text: "Already imported",
        createdAt: now,
        turnId: null,
        turnIndex: 0,
        streaming: false,
      });
      const logPath = path.join(directory, "scratch", "existing-chat.jsonl");
      yield* fs.makeDirectory(path.dirname(logPath));
      yield* fs.writeFileString(logPath, yield* encodeMessageJson(message));

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 54 });
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES ('existing-thread', 'existing-project', 'Existing chat', ${now}, ${now})`;
        const createdPayload = ThreadCreatedPayload.make({
          threadId: chat.backingThreadId,
          projectId: chat.backingProjectId,
          title: chat.title,
          modelSelection: chat.modelSelection,
          runtimeMode: chat.runtimeMode,
          interactionMode: chat.interactionMode,
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        });
        const messagePayload = ThreadMessageSentPayload.make({
          threadId: chat.backingThreadId,
          messageId: MessageId.make("existing-message"),
          role: "user",
          text: message.text,
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        });
        const createdPayloadJson = yield* encodeCreatedPayloadJson(createdPayload);
        const messagePayloadJson = yield* encodeMessagePayloadJson(messagePayload);
        yield* sql`INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
      ) VALUES
        ('existing-created', 'thread', 'existing-thread', 1, 'thread.created', ${now}, NULL, NULL, NULL, 'system', ${createdPayloadJson}, '{}'),
        ('existing-message-event', 'thread', 'existing-thread', 2, 'thread.message-sent', ${now}, NULL, NULL, NULL, 'system', ${messagePayloadJson}, '{}')`;
        const chatJson = yield* encodeChatJson(chat);
        yield* sql`INSERT INTO axis_scratch_chats VALUES (
        'existing-chat', 'environment', ${chatJson}, 'existing-project', 'existing-thread', ${now}, ${now}, ${now}
      )`;

        yield* runMigrations();

        const projection = yield* sql<{ project_id: string | null }>`
        SELECT project_id FROM projection_threads WHERE thread_id = 'existing-thread'
      `;
        assert.deepEqual(projection, [{ project_id: null }]);
        const importedEvents = yield* sql<{ event_type: string; payload_json: string }>`
        SELECT event_type, payload_json FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = 'existing-thread'
        ORDER BY stream_version
      `;
        assert.deepEqual(
          importedEvents.map((event) => event.event_type),
          ["thread.created", "thread.message-sent"],
        );
        const detached = yield* decodeCreatedPayloadJson(importedEvents[0]!.payload_json);
        assert.equal(detached.projectId, null);
      }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") })),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

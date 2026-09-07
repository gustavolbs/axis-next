import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  AxisScratchChat,
  AxisScratchChatMessage,
  MessageId,
  ThreadCreatedPayload,
  ThreadMessageSentPayload,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeChat = Schema.decodeUnknownEffect(Schema.fromJsonString(AxisScratchChat));
const decodeMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(AxisScratchChatMessage));

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ scratch_json: string }>`SELECT scratch_json FROM axis_scratch_chats`;
  if (rows.length === 0) return;
  const databases = yield* sql<{ name: string; file: string }>`PRAGMA database_list`;
  const databaseFile = databases.find((database) => database.name === "main")?.file;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const appendEvent = (
    kind: "thread" | "project",
    id: string,
    type: string,
    payload: object,
    at: string,
  ) => sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
    ) VALUES (
      ${`scratch-import:${id}:${type}:${NodeCrypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`}, ${kind}, ${id},
      (SELECT COALESCE(MAX(stream_version), 0) + 1 FROM orchestration_events WHERE aggregate_kind = ${kind} AND stream_id = ${id}),
      ${type}, ${at}, NULL, NULL, NULL, 'system', ${JSON.stringify(payload)}, '{}'
    )
  `;
  for (const row of rows) {
    const chat = yield* decodeChat(row.scratch_json);
    const existing = yield* sql<{
      thread_id: string;
    }>`SELECT thread_id FROM projection_threads WHERE thread_id = ${chat.backingThreadId}`;
    if (existing.length > 0) {
      // Detach the historical creation event too, so projection rebuilds agree.
      yield* sql`UPDATE orchestration_events SET payload_json = json_set(payload_json, '$.projectId', NULL)
        WHERE stream_id = ${chat.backingThreadId} AND event_type = 'thread.created'`;
      yield* sql`UPDATE projection_threads SET project_id = NULL WHERE thread_id = ${chat.backingThreadId}`;
    } else {
      const payload = ThreadCreatedPayload.make({
        threadId: chat.backingThreadId,
        projectId: null,
        title: chat.title,
        modelSelection: chat.modelSelection,
        runtimeMode: chat.runtimeMode,
        interactionMode: chat.interactionMode,
        branch: null,
        worktreePath: null,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
      });
      yield* appendEvent("thread", chat.backingThreadId, "thread.created", payload, chat.createdAt);
    }

    // Keep the source log untouched as a recovery copy.
    const logPath = databaseFile
      ? path.join(path.dirname(databaseFile), "scratch", `${chat.id}.jsonl`)
      : null;
    const contents =
      logPath !== null && (yield* fs.exists(logPath)) ? yield* fs.readFileString(logPath) : "";
    for (const line of contents.split("\n").filter((line) => line.trim().length > 0)) {
      const message = yield* decodeMessage(line);
      const duplicate =
        yield* sql`SELECT 1 FROM orchestration_events WHERE stream_id = ${chat.backingThreadId}
        AND event_type = 'thread.message-sent' AND json_extract(payload_json, '$.messageId') = ${message.id}`;
      if (duplicate.length > 0) continue;
      const payload = ThreadMessageSentPayload.make({
        threadId: chat.backingThreadId,
        messageId: MessageId.make(message.id),
        role: message.role,
        text: message.text,
        turnId: null,
        streaming: false,
        createdAt: message.createdAt,
        updatedAt: message.createdAt,
      });
      yield* appendEvent(
        "thread",
        chat.backingThreadId,
        "thread.message-sent",
        payload,
        message.createdAt,
      );
    }
    if (existing.length === 0 && chat.archivedAt !== null) {
      yield* appendEvent(
        "thread",
        chat.backingThreadId,
        "thread.archived",
        {
          threadId: chat.backingThreadId,
          archivedAt: chat.archivedAt,
          updatedAt: chat.updatedAt,
        },
        chat.archivedAt,
      );
    }
    if (chat.backingProjectId !== null) {
      const remaining =
        yield* sql`SELECT 1 FROM projection_threads WHERE project_id = ${chat.backingProjectId} AND deleted_at IS NULL`;
      if (remaining.length === 0)
        yield* appendEvent(
          "project",
          chat.backingProjectId,
          "project.deleted",
          {
            projectId: chat.backingProjectId,
            deletedAt: chat.updatedAt,
          },
          chat.updatedAt,
        );
    }
  }
}).pipe(Effect.provide(NodeServices.layer));

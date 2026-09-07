import { describe, expect, it } from "@effect/vitest";
import { AxisScratchChatSnapshot, AxisScratchChatMessageId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { applyScratchChatEvent } from "./axisScratchChat.ts";

const snapshot = Schema.decodeUnknownSync(AxisScratchChatSnapshot)({
  chat: {
    id: "chat",
    environmentId: "environment",
    title: "Chat",
    modelSelection: { instanceId: "codex", model: "auto" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    providerInstanceId: "codex",
    contextId: null,
    backingProjectId: null,
    backingThreadId: "session",
    lastMessagePreview: null,
    messageCount: 0,
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    lastMessageAt: null,
    archivedAt: null,
  },
  messages: [],
  cursor: null,
  turnState: "running",
});
const message = {
  id: AxisScratchChatMessageId.make("reply"),
  chatId: snapshot.chat.id,
  role: "assistant" as const,
  authorName: null,
  text: "",
  createdAt: snapshot.chat.createdAt,
  turnId: null,
  turnIndex: 0,
  streaming: true,
};

describe("standalone chat stream projection", () => {
  it.effect(
    "accumulates every delta before publishing state and replaces final text without duplication",
    () =>
      Effect.gen(function* () {
        const states = yield* Stream.make(
          { kind: "snapshot" as const, snapshot },
          { kind: "message-appended" as const, message },
          { kind: "message-delta" as const, messageId: message.id, delta: "Hello " },
          { kind: "message-delta" as const, messageId: message.id, delta: "world" },
          {
            kind: "message-appended" as const,
            message: { ...message, text: "Hello world!", streaming: false },
          },
        ).pipe(Stream.scan(null, applyScratchChatEvent), Stream.runCollect);
        expect(states.at(-2)?.messages[0]?.text).toBe("Hello world");
        expect(states.at(-1)?.messages).toEqual([
          { ...message, text: "Hello world!", streaming: false },
        ]);
        expect(states.at(-1)?.cursor).toBe(message.id);
      }),
  );

  it("replaces a disconnected client's state with the server snapshot", () => {
    const partial = applyScratchChatEvent(snapshot, { kind: "message-appended", message });
    expect(applyScratchChatEvent(partial, { kind: "snapshot", snapshot })).toEqual(snapshot);
    expect(
      applyScratchChatEvent(partial, { kind: "chat-removed", chatId: snapshot.chat.id }),
    ).toBeNull();
  });
});

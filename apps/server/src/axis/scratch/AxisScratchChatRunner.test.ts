import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  AxisScratchChatId,
  AxisScratchChatMessageId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type AxisScratchChat,
  type AxisScratchChatMessage,
} from "@t3tools/contracts";
import { AxisScratchChatStore } from "./AxisScratchChatStore.ts";
import { AxisScratchChatMessageLog } from "./AxisScratchChatMessageLog.ts";
import { make } from "./AxisScratchChatRunner.ts";

const chat: AxisScratchChat = {
  id: AxisScratchChatId.make("legacy-chat"),
  environmentId: EnvironmentId.make("environment"),
  title: "Legacy chat",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "auto" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  providerInstanceId: ProviderInstanceId.make("codex"),
  contextId: null,
  backingProjectId: null,
  backingThreadId: ThreadId.make("legacy-thread"),
  lastMessagePreview: "Hello",
  messageCount: 1,
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
  lastMessageAt: "2026-09-07T00:00:00.000Z",
  archivedAt: null,
};

const message: AxisScratchChatMessage = {
  id: AxisScratchChatMessageId.make("legacy-message"),
  chatId: chat.id,
  role: "assistant",
  authorName: null,
  text: "Hello",
  createdAt: "2026-09-07T00:00:00.000Z",
  turnId: null,
  turnIndex: 0,
  streaming: false,
};

it.effect("keeps legacy list, get and snapshot subscription reads available", () => {
  const listCalls: Array<{ environmentId: string; includeArchived: boolean }> = [];
  const tailCalls: Array<{
    chatId: AxisScratchChatId;
    limit?: number;
    afterMessageId?: AxisScratchChatMessageId;
  }> = [];
  return Effect.gen(function* () {
    const runner = yield* make;
    const listed = yield* runner.list({ environmentId: chat.environmentId });
    assert.deepEqual(listed, [chat]);
    assert.deepEqual(listCalls, [{ environmentId: chat.environmentId, includeArchived: false }]);

    const snapshot = yield* runner.get({
      chatId: chat.id,
      limit: 25,
      afterMessageId: message.id,
    });
    assert.deepEqual(snapshot, { chat, messages: [message], cursor: message.id });
    assert.deepEqual(tailCalls, [{ chatId: chat.id, limit: 25, afterMessageId: message.id }]);

    const stream = yield* runner.subscribe({ chatId: chat.id });
    const first = Option.getOrThrow(yield* Stream.runHead(stream));
    assert.deepEqual(first, {
      kind: "snapshot",
      snapshot: { chat, messages: [message], cursor: message.id },
    });
    assert.deepEqual(tailCalls[1], { chatId: chat.id });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(AxisScratchChatStore)({
          get: () => Effect.succeed(chat),
          list: (input) => {
            listCalls.push(input);
            return Effect.succeed([chat]);
          },
        }),
        Layer.mock(AxisScratchChatMessageLog)({
          readTail: (input) => {
            tailCalls.push(input);
            return Effect.succeed({ messages: [message], headId: message.id });
          },
        }),
      ),
    ),
  );
});

it.effect("rejects legacy writes after conversations move to orchestration", () =>
  Effect.gen(function* () {
    const runner = yield* make;
    for (const operation of [
      runner.patch,
      runner.archive,
      runner.remove,
      runner.interrupt,
      runner.sendMessage,
      runner.create,
    ]) {
      // All retired operations fail before accessing metadata, files or providers.
      const result = yield* operation().pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(AxisScratchChatStore)({}),
        Layer.mock(AxisScratchChatMessageLog)({}),
      ),
    ),
  ),
);

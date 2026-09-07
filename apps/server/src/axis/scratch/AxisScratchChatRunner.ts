import {
  type AxisScratchChat,
  type AxisScratchChatDraft,
  type AxisScratchChatError,
  type AxisScratchChatMessage,
  type AxisScratchChatSnapshot,
  type AxisScratchChatStreamEvent,
  AxisScratchChatValidationError,
  type AxisScratchChatGetInput,
  type AxisScratchChatListInput,
  type AxisScratchChatPatchInput,
  type AxisScratchChatArchiveInput,
  type AxisScratchChatRemoveInput,
  type AxisScratchChatSendMessageInput,
  type AxisScratchChatSubscribeInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { AxisScratchChatMessageLog } from "./AxisScratchChatMessageLog.ts";
import { AxisScratchChatStore } from "./AxisScratchChatStore.ts";

// Retained for bookmarked scratch URLs and old clients. Migration 057 imports
// these conversations into orchestration; all subsequent writes belong there.
export class AxisScratchChatRunner extends Context.Service<
  AxisScratchChatRunner,
  {
    readonly list: (
      input: AxisScratchChatListInput & { readonly environmentId: EnvironmentId },
    ) => Effect.Effect<ReadonlyArray<AxisScratchChat>, AxisScratchChatError>;
    readonly get: (
      input: AxisScratchChatGetInput,
    ) => Effect.Effect<AxisScratchChatSnapshot, AxisScratchChatError>;
    readonly subscribe: (
      input: AxisScratchChatSubscribeInput,
    ) => Effect.Effect<Stream.Stream<AxisScratchChatStreamEvent>, AxisScratchChatError>;
    readonly create: (input: {
      readonly draft: AxisScratchChatDraft;
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<AxisScratchChat, AxisScratchChatError>;
    readonly patch: (
      input: AxisScratchChatPatchInput,
    ) => Effect.Effect<AxisScratchChat, AxisScratchChatError>;
    readonly archive: (
      input: AxisScratchChatArchiveInput,
    ) => Effect.Effect<AxisScratchChat, AxisScratchChatError>;
    readonly remove: (
      input: AxisScratchChatRemoveInput,
    ) => Effect.Effect<void, AxisScratchChatError>;
    readonly interrupt: (
      input: AxisScratchChatRemoveInput,
    ) => Effect.Effect<void, AxisScratchChatError>;
    readonly sendMessage: (
      input: AxisScratchChatSendMessageInput,
    ) => Effect.Effect<AxisScratchChatMessage, AxisScratchChatError>;
  }
>()("t3/axis/scratch/AxisScratchChatRunner") {}

export const make = Effect.gen(function* () {
  const store = yield* AxisScratchChatStore;
  const messageLog = yield* AxisScratchChatMessageLog;
  const moved = () =>
    Effect.fail(
      new AxisScratchChatValidationError({
        message:
          "This conversation has moved to Chats. Update your client and open it from the sidebar.",
      }),
    );
  const get = Effect.fn("AxisScratchChatRunner.get")(function* (input: AxisScratchChatGetInput) {
    const chat = yield* store.get(input.chatId);
    const tail = yield* messageLog.readTail({
      chatId: input.chatId,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.afterMessageId === undefined ? {} : { afterMessageId: input.afterMessageId }),
    });
    return { chat, messages: tail.messages, cursor: tail.headId };
  });
  return {
    list: ({ environmentId, includeArchived }) =>
      store.list({ environmentId, includeArchived: includeArchived ?? false }),
    get,
    subscribe: (input) =>
      get(input).pipe(Effect.map((snapshot) => Stream.succeed({ kind: "snapshot", snapshot }))),
    create: moved,
    patch: moved,
    archive: moved,
    remove: moved,
    interrupt: moved,
    sendMessage: moved,
  } satisfies AxisScratchChatRunner["Service"];
});

export const layer = Layer.effect(AxisScratchChatRunner, make);

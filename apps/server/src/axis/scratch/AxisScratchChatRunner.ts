import * as NodeCrypto from "node:crypto";
import {
  type AxisScratchChat,
  type AxisScratchChatDraft,
  type AxisScratchChatError,
  AxisScratchChatId,
  type AxisScratchChatMessage,
  AxisScratchChatMessageId,
  type AxisScratchChatSnapshot,
  type AxisScratchChatStreamEvent,
  AxisScratchChatPersistenceError,
  AxisScratchChatProviderUnavailableError,
  AxisScratchChatValidationError,
  type AxisScratchChatGetInput,
  type AxisScratchChatListInput,
  type AxisScratchChatPatchInput,
  type AxisScratchChatArchiveInput,
  type AxisScratchChatRemoveInput,
  type AxisScratchChatSendMessageInput,
  type AxisScratchChatSubscribeInput,
  type AxisScratchChatTurnState,
  CommandId,
  type EnvironmentId,
  type ProviderRuntimeEvent,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/ProviderSessionRuntime.ts";
import * as ServerConfig from "../../config.ts";
import { AxisScratchChatMessageLog } from "./AxisScratchChatMessageLog.ts";
import { AxisScratchChatStore } from "./AxisScratchChatStore.ts";

const isoNow = Effect.map(DateTime.now, DateTime.formatIso);
const validationError = (message: string) => new AxisScratchChatValidationError({ message });
const providerError = (error: unknown) =>
  validationError(error instanceof Error ? error.message : String(error));

export class AxisScratchChatRunner extends Context.Service<
  AxisScratchChatRunner,
  {
    readonly list: (
      input: AxisScratchChatListInput & { readonly environmentId: EnvironmentId },
    ) => Effect.Effect<ReadonlyArray<AxisScratchChat>, AxisScratchChatError>;
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
    readonly get: (
      input: AxisScratchChatGetInput,
    ) => Effect.Effect<AxisScratchChatSnapshot, AxisScratchChatError>;
    readonly sendMessage: (
      input: AxisScratchChatSendMessageInput,
    ) => Effect.Effect<AxisScratchChatMessage, AxisScratchChatError>;
    readonly subscribe: (
      input: AxisScratchChatSubscribeInput,
    ) => Effect.Effect<
      Stream.Stream<AxisScratchChatStreamEvent>,
      AxisScratchChatError,
      Scope.Scope
    >;
  }
>()("t3/axis/scratch/AxisScratchChatRunner") {}

export const make = Effect.gen(function* () {
  const store = yield* AxisScratchChatStore;
  const messageLog = yield* AxisScratchChatMessageLog;
  const providers = yield* ProviderInstanceRegistry;
  const provider = yield* ProviderService;
  const sessionRepository = yield* ProviderSessionRuntimeRepository;
  // Used only when explicitly deleting a chat created by the old implementation.
  const orchestration = yield* OrchestrationEngineService;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const bus = yield* PubSub.unbounded<{
    readonly chatId: AxisScratchChatId;
    readonly event: AxisScratchChatStreamEvent;
  }>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(bus));

  type ActiveTurn = {
    readonly chatId: AxisScratchChatId;
    readonly messages: Map<string, AxisScratchChatMessage>;
    readonly completedItems: Set<string>;
    turnId?: TurnId;
  };
  const active = new Map<ThreadId, ActiveTurn>();
  // Serializes mutations within a chat without blocking other conversations.
  const locks = new Map<
    AxisScratchChatId,
    { readonly semaphore: Semaphore.Semaphore; users: number }
  >();
  const locked = <A, E, R>(chatId: AxisScratchChatId, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const lock = locks.get(chatId) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        lock.users++;
        locks.set(chatId, lock);
        return lock;
      }),
      (lock) => lock.semaphore.withPermit(effect),
      (lock) =>
        Effect.sync(() => {
          if (--lock.users === 0) locks.delete(chatId);
        }),
    );
  const publish = (chatId: AxisScratchChatId, event: AxisScratchChatStreamEvent) =>
    PubSub.publish(bus, { chatId, event });

  const ensureProvider = Effect.fn("AxisScratchChatRunner.ensureProvider")(function* (
    draft: Pick<AxisScratchChat, "providerInstanceId" | "modelSelection">,
  ) {
    if (draft.modelSelection.instanceId !== draft.providerInstanceId)
      return yield* validationError("The model must belong to this chat's provider.");
    const instance = yield* providers.getInstance(draft.providerInstanceId);
    if (instance === undefined || !instance.enabled) {
      return yield* new AxisScratchChatProviderUnavailableError({
        instanceId: draft.providerInstanceId,
        message: "The selected provider is unavailable or disabled.",
      });
    }
    return instance;
  });

  const persistMessage = Effect.fn("AxisScratchChatRunner.persistMessage")(function* (
    message: AxisScratchChatMessage,
  ) {
    yield* messageLog.append(message.chatId, message);
    const chat = yield* store.get(message.chatId);
    yield* store.setLastMessage({
      id: chat.id,
      lastMessagePreview: message.text.replace(/\s+/g, " ").trim().slice(0, 280),
      lastMessageAt: message.createdAt,
      messageCount: chat.messageCount + 1,
      updatedAt: yield* isoNow,
    });
    yield* publish(chat.id, { kind: "message-appended", message });
  });

  const finish = Effect.fn("AxisScratchChatRunner.finish")(function* (
    threadId: ThreadId,
    state: AxisScratchChatTurnState,
    error?: string,
  ) {
    const turn = active.get(threadId);
    if (!turn) return;
    for (const message of turn.messages.values()) {
      if (message.text.trim()) yield* persistMessage({ ...message, streaming: false });
    }
    if (error) {
      const chat = yield* store.get(turn.chatId);
      yield* persistMessage({
        id: AxisScratchChatMessageId.make(NodeCrypto.randomUUID()),
        chatId: turn.chatId,
        role: "system",
        authorName: null,
        text: error,
        createdAt: yield* isoNow,
        turnId: null,
        turnIndex: chat.messageCount,
        streaming: false,
      });
    }
    active.delete(threadId);
    yield* publish(turn.chatId, { kind: "turn-state", threadId, turnId: null, state });
  });

  const handleEvent = Effect.fn("AxisScratchChatRunner.handleEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    const turn = active.get(event.threadId);
    if (!turn) return;
    if (event.turnId !== undefined && turn.turnId !== undefined && event.turnId !== turn.turnId)
      return;
    if (
      (event.type === "content.delta" && event.payload.streamKind === "assistant_text") ||
      (event.type === "item.completed" && event.payload.itemType === "assistant_message")
    ) {
      const key = event.itemId ?? event.turnId ?? "assistant";
      if (turn.completedItems.has(key)) return;
      let message = turn.messages.get(key);
      if (!message) {
        const chat = yield* store.get(turn.chatId);
        message = {
          id: AxisScratchChatMessageId.make(NodeCrypto.randomUUID()),
          chatId: turn.chatId,
          role: "assistant",
          authorName: null,
          text: "",
          createdAt: event.createdAt,
          turnId: event.turnId ?? null,
          turnIndex: chat.messageCount + turn.messages.size,
          streaming: true,
        };
        turn.messages.set(key, message);
        yield* publish(turn.chatId, { kind: "message-appended", message });
      }
      if (event.type === "content.delta") {
        turn.messages.set(key, { ...message, text: message.text + event.payload.delta });
        yield* publish(turn.chatId, {
          kind: "message-delta",
          messageId: message.id,
          delta: event.payload.delta,
        });
      } else {
        const completed = {
          ...message,
          text: event.payload.detail ?? message.text,
          streaming: false,
        };
        if (completed.text.trim()) yield* persistMessage(completed);
        turn.messages.delete(key);
        turn.completedItems.add(key);
      }
    } else if (event.type === "turn.completed") {
      yield* finish(
        event.threadId,
        event.payload.state === "failed"
          ? "error"
          : event.payload.state === "completed"
            ? "completed"
            : "interrupted",
        event.payload.errorMessage,
      );
    } else if (event.type === "runtime.error") {
      yield* finish(event.threadId, "error", event.payload.message);
    } else if (event.type === "turn.aborted" || event.type === "session.exited") {
      yield* finish(
        event.threadId,
        "interrupted",
        "The provider session ended before completing the response.",
      );
    } else if (event.type === "request.opened") {
      // A plain chat has no approval or structured tool-input surface.
      yield* provider
        .interruptTurn({ threadId: event.threadId })
        .pipe(Effect.mapError(providerError));
      yield* finish(
        event.threadId,
        "error",
        "This request needs agent tools. Continue it in a project conversation.",
      );
    }
  });

  // The server owns ingestion for the entire turn, even with no connected clients.
  yield* provider.streamEvents.pipe(
    Stream.runForEach((event) => {
      const turn = active.get(event.threadId);
      if (!turn) return Effect.void;
      return locked(turn.chatId, handleEvent(event)).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            active.delete(event.threadId);
            yield* Effect.logError("Could not persist standalone chat response", { cause });
            yield* publish(turn.chatId, {
              kind: "turn-state",
              threadId: event.threadId,
              turnId: null,
              state: "error",
            });
          }),
        ),
      );
    }),
    Effect.forkScoped({ startImmediately: true }),
  );

  const list: AxisScratchChatRunner["Service"]["list"] = ({ environmentId, includeArchived }) =>
    store.list({ environmentId, includeArchived: includeArchived ?? false });

  const create: AxisScratchChatRunner["Service"]["create"] = Effect.fn(
    "AxisScratchChatRunner.create",
  )(function* ({ draft, environmentId }) {
    yield* ensureProvider(draft);
    const createdAt = yield* isoNow;
    return yield* store.create({
      ...draft,
      id: AxisScratchChatId.make(NodeCrypto.randomUUID()),
      environmentId,
      title: draft.title ?? "New chat",
      contextId: draft.contextId ?? null,
      backingProjectId: null,
      backingThreadId: ThreadId.make(NodeCrypto.randomUUID()),
      lastMessagePreview: null,
      messageCount: 0,
      createdAt,
      updatedAt: createdAt,
      lastMessageAt: null,
      archivedAt: null,
    });
  });

  const patch: AxisScratchChatRunner["Service"]["patch"] = ({ patch }) =>
    locked(
      patch.id,
      Effect.gen(function* () {
        const chat = yield* store.patch(patch, yield* isoNow);
        yield* publish(chat.id, { kind: "chat-patched", chat });
        return chat;
      }),
    );

  const archive: AxisScratchChatRunner["Service"]["archive"] = ({ chatId, archived }) =>
    locked(
      chatId,
      Effect.gen(function* () {
        const current = yield* store.get(chatId);
        if (active.has(current.backingThreadId))
          return yield* validationError("Wait for the response before archiving this chat.");
        const chat = yield* store.archive(chatId, archived === false ? null : yield* isoNow);
        yield* publish(chatId, { kind: "chat-archived", chat });
        return chat;
      }),
    );

  const remove: AxisScratchChatRunner["Service"]["remove"] = ({ chatId }) =>
    locked(
      chatId,
      Effect.gen(function* () {
        const chat = yield* store.get(chatId);
        const sessions = yield* provider.listSessions();
        if (sessions.some((session) => session.threadId === chat.backingThreadId))
          yield* provider
            .stopSession({ threadId: chat.backingThreadId })
            .pipe(Effect.mapError(providerError));
        active.delete(chat.backingThreadId);
        if (chat.backingProjectId !== null)
          yield* orchestration
            .dispatch({
              type: "project.delete",
              commandId: CommandId.make(NodeCrypto.randomUUID()),
              projectId: chat.backingProjectId,
              force: true,
            })
            .pipe(Effect.mapError(providerError));
        yield* messageLog.remove(chatId);
        yield* fs
          .remove(path.join(config.stateDir, "scratch", chatId), { recursive: true, force: true })
          .pipe(
            Effect.mapError(
              () =>
                new AxisScratchChatPersistenceError({ operation: "remove chat session directory" }),
            ),
          );
        yield* sessionRepository
          .deleteByThreadId({ threadId: chat.backingThreadId })
          .pipe(
            Effect.mapError(
              () =>
                new AxisScratchChatPersistenceError({ operation: "remove chat provider session" }),
            ),
          );
        yield* store.remove(chatId);
        yield* publish(chatId, { kind: "chat-removed", chatId });
      }),
    );

  const snapshot = Effect.fn("AxisScratchChatRunner.snapshot")(function* (
    input: AxisScratchChatGetInput,
  ) {
    const chat = yield* store.get(input.chatId);
    const tail = yield* messageLog.readTail({
      chatId: input.chatId,
      limit: input.limit ?? 200,
      ...(input.afterMessageId === undefined ? {} : { afterMessageId: input.afterMessageId }),
    });
    const turn = active.get(chat.backingThreadId);
    return {
      chat,
      messages: [...tail.messages, ...(turn?.messages.values() ?? [])],
      cursor: tail.headId,
      ...(turn ? { turnState: "running" as const } : {}),
    };
  });
  const get: AxisScratchChatRunner["Service"]["get"] = (input) =>
    locked(input.chatId, snapshot(input));

  const interrupt: AxisScratchChatRunner["Service"]["interrupt"] = ({ chatId }) =>
    locked(
      chatId,
      Effect.gen(function* () {
        const chat = yield* store.get(chatId);
        if (!active.has(chat.backingThreadId)) return;
        yield* provider
          .interruptTurn({ threadId: chat.backingThreadId })
          .pipe(Effect.mapError(providerError));
        yield* finish(chat.backingThreadId, "interrupted");
      }),
    );

  const sendMessage: AxisScratchChatRunner["Service"]["sendMessage"] = (input) =>
    locked(
      input.chatId,
      Effect.gen(function* () {
        const chat = yield* store.get(input.chatId);
        if (chat.archivedAt !== null) return yield* validationError("This chat is archived.");
        if (active.has(chat.backingThreadId))
          return yield* validationError("This chat already has a response in progress.");
        const modelSelection = input.modelSelection ?? chat.modelSelection;
        yield* ensureProvider({ ...chat, modelSelection });
        const sessions = yield* provider.listSessions();
        if (
          !sessions.some(
            (session) =>
              session.threadId === chat.backingThreadId &&
              session.status !== "closed" &&
              session.status !== "error",
          )
        ) {
          const cwd = path.join(config.stateDir, "scratch", chat.id);
          yield* fs.makeDirectory(cwd, { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new AxisScratchChatPersistenceError({
                  operation: "create chat session directory",
                }),
            ),
          );
          yield* provider
            .startSession(chat.backingThreadId, {
              threadId: chat.backingThreadId,
              providerInstanceId: chat.providerInstanceId,
              cwd,
              title: chat.title,
              modelSelection,
              runtimeMode: "approval-required",
              approvalPolicy: "never",
              sandboxMode: "read-only",
            })
            .pipe(Effect.mapError(providerError));
        }
        const message: AxisScratchChatMessage = {
          id: AxisScratchChatMessageId.make(NodeCrypto.randomUUID()),
          chatId: chat.id,
          role: "user",
          authorName: null,
          text: input.text,
          createdAt: yield* isoNow,
          turnId: null,
          turnIndex: chat.messageCount,
          streaming: false,
        };
        if (chat.messageCount === 0 && chat.title === "New chat") {
          const renamed = yield* store.patch(
            { id: chat.id, title: input.text.replace(/\s+/g, " ").trim().slice(0, 200) },
            yield* isoNow,
          );
          yield* publish(chat.id, { kind: "chat-patched", chat: renamed });
        }
        yield* persistMessage(message);
        active.set(chat.backingThreadId, {
          chatId: chat.id,
          messages: new Map(),
          completedItems: new Set(),
        });
        yield* publish(chat.id, {
          kind: "turn-state",
          threadId: chat.backingThreadId,
          turnId: null,
          state: "running",
        });
        const started = yield* provider
          .sendTurn({
            threadId: chat.backingThreadId,
            input: input.text,
            modelSelection,
            interactionMode: "default",
          })
          .pipe(
            Effect.mapError(providerError),
            Effect.tapError((error) => finish(chat.backingThreadId, "error", error.message)),
          );
        const turn = active.get(chat.backingThreadId);
        if (turn) turn.turnId = started.turnId;
        return message;
      }).pipe(Effect.uninterruptible),
    );

  const subscribe: AxisScratchChatRunner["Service"]["subscribe"] = Effect.fn(
    "AxisScratchChatRunner.subscribe",
  )(function* (input) {
    // Subscribe and snapshot under the same lock, preventing lost or repeated deltas.
    const initial = yield* locked(
      input.chatId,
      Effect.gen(function* () {
        const queue = yield* PubSub.subscribe(bus);
        return { queue, snapshot: yield* snapshot(input) };
      }),
    );
    return Stream.concat(
      Stream.succeed({
        kind: "snapshot",
        snapshot: initial.snapshot,
      } satisfies AxisScratchChatStreamEvent),
      Stream.fromSubscription(initial.queue).pipe(
        Stream.filter((entry) => entry.chatId === input.chatId),
        Stream.map((entry) => entry.event),
      ),
    );
  });

  return {
    list,
    create,
    patch,
    archive,
    remove,
    interrupt,
    get,
    sendMessage,
    subscribe,
  } satisfies AxisScratchChatRunner["Service"];
});

export const layer = Layer.effect(AxisScratchChatRunner, make);

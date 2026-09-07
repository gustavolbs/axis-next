import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  AxisScratchChatDraft,
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  TurnId,
  type OrchestrationCommand,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
} from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderValidationError } from "../../provider/Errors.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ServerConfig from "../../config.ts";
import { make } from "./AxisScratchChatRunner.ts";
import { layer as storeLayer } from "./AxisScratchChatStore.ts";
import { layer as messageLogLayer } from "./AxisScratchChatMessageLog.ts";

const now = "2026-09-07T00:00:00.000Z";
const draft = Schema.decodeUnknownSync(AxisScratchChatDraft)({
  title: "Initial title",
  modelSelection: { instanceId: "codex", model: "auto" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  providerInstanceId: "codex",
});

const harness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped();
  const config = ServerConfig.layerTest(directory, directory);
  const commands: OrchestrationCommand[] = [];
  const starts: ProviderSessionStartInput[] = [];
  const sends: ProviderSendTurnInput[] = [];
  const sessions: ProviderSession[] = [];
  const failure = { send: false };
  const events = yield* Queue.unbounded<{
    event: ProviderRuntimeEvent;
    receipt: Deferred.Deferred<void>;
  }>();
  const dependencies = yield* Layer.build(
    Layer.mergeAll(
      ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
      storeLayer.pipe(Layer.provide(SqlitePersistenceMemory)),
      messageLogLayer.pipe(Layer.provide(config)),
      config,
      Layer.mock(ProviderInstanceRegistry)({
        getInstance: () =>
          Effect.succeed({ instanceId: "codex", driverKind: "codex", enabled: true } as never),
      }),
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
      }),
      Layer.mock(ProviderService)({
        listSessions: () => Effect.succeed(sessions),
        startSession: (threadId, input) =>
          Effect.sync(() => {
            starts.push(input);
            const session: ProviderSession = {
              threadId,
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId: draft.providerInstanceId,
              status: "ready",
              runtimeMode: "approval-required",
              createdAt: now,
              updatedAt: now,
            };
            sessions.push(session);
            return session;
          }),
        sendTurn: (input) =>
          Effect.gen(function* () {
            sends.push(input);
            if (failure.send)
              return yield* new ProviderValidationError({
                operation: "send",
                issue: "Provider unavailable",
              });
            return { threadId: input.threadId, turnId: TurnId.make("turn-1") };
          }),
        stopSession: () =>
          Effect.sync(() => {
            sessions.length = 0;
          }),
        interruptTurn: () => Effect.void,
        // Acknowledge only after downstream ingestion has processed the event.
        streamEvents: Stream.fromQueue(events).pipe(
          Stream.flatMap(({ event, receipt }) =>
            Stream.concat(
              Stream.succeed(event),
              Stream.fromEffect(Deferred.succeed(receipt, undefined)).pipe(Stream.drain),
            ),
          ),
        ),
      }),
    ),
  );
  const service = yield* make.pipe(Effect.provide(dependencies));
  const emit = Effect.fn(function* (event: ProviderRuntimeEvent) {
    const receipt = yield* Deferred.make<void>();
    yield* Queue.offer(events, { event, receipt });
    yield* Deferred.await(receipt);
  });
  const create = () => service.create({ draft, environmentId: EnvironmentId.make("env-test") });
  return { service, create, commands, starts, sends, sessions, failure, emit };
});

const withHarness = <A, E>(
  run: (h: Effect.Success<typeof harness>) => Effect.Effect<A, E, import("effect/Scope").Scope>,
) =>
  Effect.gen(function* () {
    return yield* run(yield* harness);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("creates and deletes standalone chats without orchestration projects or threads", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const chat = yield* h.create();
      assert.equal(chat.backingProjectId, null);
      assert.equal(h.starts.length, 0);
      yield* h.service.sendMessage({ chatId: chat.id, text: "hello" });
      assert.equal(h.starts.length, 1);
      assert.equal(h.starts[0]?.sandboxMode, "read-only");
      assert.equal(h.sends[0]?.input, "hello");
      yield* h.service.remove({ chatId: chat.id });
      assert.deepEqual(h.commands, []);
      assert.equal(h.sessions.length, 0);
      assert.equal((yield* h.service.list({ environmentId: chat.environmentId })).length, 0);
    }),
  ),
);

it.effect("persists provider output without a client subscription and reuses the session", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const chat = yield* h.create();
      yield* h.service.sendMessage({ chatId: chat.id, text: "hello" });
      const base = {
        eventId: EventId.make("event-1"),
        provider: ProviderDriverKind.make("codex"),
        threadId: chat.backingThreadId,
        createdAt: now,
        turnId: TurnId.make("turn-1"),
        itemId: RuntimeItemId.make("item-1"),
      };
      yield* h.emit({
        ...base,
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: "Hello " },
      });
      yield* h.emit({
        ...base,
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: "world" },
      });
      const running = yield* h.service.get({ chatId: chat.id });
      assert.equal(running.turnState, "running");
      assert.equal(running.messages[1]?.text, "Hello world");
      yield* h.emit({
        ...base,
        type: "item.completed",
        payload: { itemType: "assistant_message", detail: "Hello world" },
      });
      yield* h.emit({
        ...base,
        type: "item.completed",
        payload: { itemType: "assistant_message", detail: "Hello world" },
      });
      yield* h.emit({ ...base, type: "turn.completed", payload: { state: "completed" } });
      const snapshot = yield* h.service.get({ chatId: chat.id });
      assert.deepEqual(
        snapshot.messages.map((message) => message.text),
        ["hello", "Hello world"],
      );
      assert.equal(snapshot.chat.messageCount, 2);
      assert.equal(snapshot.messages[1]?.streaming, false);
      yield* h.service.sendMessage({ chatId: chat.id, text: "next" });
      assert.equal(h.starts.length, 1);
    }),
  ),
);

it.effect(
  "rejects overlapping turns and a model from another provider without appending messages",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const chat = yield* h.create();
        const mismatch = yield* h.service
          .sendMessage({
            chatId: chat.id,
            text: "bad",
            modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "auto" },
          })
          .pipe(Effect.flip);
        assert.equal(mismatch._tag, "AxisScratchChatValidationError");
        yield* h.service.sendMessage({ chatId: chat.id, text: "first" });
        const busy = yield* h.service
          .sendMessage({ chatId: chat.id, text: "second" })
          .pipe(Effect.flip);
        assert.equal(busy._tag, "AxisScratchChatValidationError");
        assert.equal((yield* h.service.get({ chatId: chat.id })).messages.length, 1);
      }),
    ),
);

it.effect("records send failures and allows retry", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const chat = yield* h.create();
      h.failure.send = true;
      yield* h.service.sendMessage({ chatId: chat.id, text: "hello" }).pipe(Effect.flip);
      const snapshot = yield* h.service.get({ chatId: chat.id });
      assert.equal(snapshot.messages[1]?.role, "system");
      assert.equal(snapshot.turnState, undefined);
      h.failure.send = false;
      yield* h.service.sendMessage({ chatId: chat.id, text: "try again" });
    }),
  ),
);

it.effect("archives, restores and renames a standalone chat", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const chat = yield* h.create();
      yield* h.service.archive({ chatId: chat.id });
      const error = yield* h.service.sendMessage({ chatId: chat.id, text: "no" }).pipe(Effect.flip);
      assert.equal(error._tag, "AxisScratchChatValidationError");
      yield* h.service.archive({ chatId: chat.id, archived: false });
      assert.equal(
        (yield* h.service.patch({ patch: { id: chat.id, title: "Renamed" } })).title,
        "Renamed",
      );
      yield* h.service.sendMessage({ chatId: chat.id, text: "yes" });
    }),
  ),
);

it.effect("broadcasts independently to clients and keeps ingestion alive after a disconnect", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const chat = yield* h.create();
      yield* h.service.sendMessage({ chatId: chat.id, text: "hello" });
      const remainingClient = yield* h.service.subscribe({ chatId: chat.id });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const disconnectedClient = yield* h.service.subscribe({ chatId: chat.id });
          const snapshot = yield* disconnectedClient.pipe(Stream.take(1), Stream.runCollect);
          assert.equal(snapshot[0]?.kind, "snapshot");
        }),
      );
      const base = {
        eventId: EventId.make("stream-event"),
        provider: ProviderDriverKind.make("codex"),
        threadId: chat.backingThreadId,
        createdAt: now,
        turnId: TurnId.make("turn-1"),
        itemId: RuntimeItemId.make("item-1"),
      };
      yield* h.emit({
        ...base,
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: "Reply" },
      });
      yield* h.emit({ ...base, type: "turn.completed", payload: { state: "completed" } });
      const events = yield* remainingClient.pipe(Stream.take(5), Stream.runCollect);
      assert.deepEqual(
        events.map((event) => event.kind),
        ["snapshot", "message-appended", "message-delta", "message-appended", "turn-state"],
      );
      assert.equal((yield* h.service.get({ chatId: chat.id })).messages[1]?.text, "Reply");
    }),
  ),
);

it.effect("stops a response, persists partial text and resumes after a provider process ends", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const chat = yield* h.create();
      yield* h.service.sendMessage({ chatId: chat.id, text: "hello" });
      yield* h.emit({
        eventId: EventId.make("partial"),
        provider: ProviderDriverKind.make("codex"),
        threadId: chat.backingThreadId,
        createdAt: now,
        turnId: TurnId.make("turn-1"),
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: "Partial reply" },
      });
      yield* h.service.interrupt({ chatId: chat.id });
      assert.equal((yield* h.service.get({ chatId: chat.id })).messages[1]?.text, "Partial reply");
      h.sessions.length = 0;
      yield* h.service.sendMessage({ chatId: chat.id, text: "continue" });
      assert.equal(h.starts.length, 2);
      assert.equal(h.starts[0]?.threadId, h.starts[1]?.threadId);
    }),
  ),
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  AxisContextId,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { AxisProjectScope, AxisProjectScopeResolutionError } from "../projects/AxisProjectScope.ts";
import {
  execute,
  CANCELLATION_TIMEOUT_MS,
  EXECUTION_TIMEOUT_MS,
  MAX_EXECUTION_TEXT_LENGTH,
} from "./AxisTaskExecution.ts";

const input = {
  scope: {
    contextId: AxisContextId.make("context"),
    project: { environmentId: EnvironmentId.make("env"), projectId: ProjectId.make("project") },
  },
  threadId: ThreadId.make("attempt-one"),
  commandId: CommandId.make("execute-one"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "approval-required" as const,
  prompt: "Analyze the project without changing files.",
};
const now = "2026-09-10T12:00:00.000Z";
const turnId = TurnId.make("provider-turn-one");
const layer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  ProjectionTurnRepositoryLive,
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "axis-execution-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    Layer.succeed(AxisProjectScope, {
      resolve: (request) => Effect.succeed(request),
      resolveProject: (request) => Effect.succeed(request),
    }),
  ),
);

const setup = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  let seq = 0;
  const id = () => CommandId.make(`test-${++seq}`);
  yield* engine.dispatch({
    type: "project.create",
    commandId: id(),
    projectId: input.scope.project.projectId,
    title: "Test project",
    workspaceRoot: process.cwd(),
    defaultModelSelection: input.modelSelection,
    createdAt: now,
  });
  const events = yield* engine.subscribeDomainEvents;
  const requested = yield* Deferred.make<void>();
  const interrupted = yield* Deferred.make<void>();
  yield* events.pipe(
    Stream.runForEach((event) => {
      if (event.type === "thread.turn-start-requested")
        return Deferred.succeed(requested, undefined).pipe(Effect.asVoid);
      if (event.type === "thread.turn-interrupt-requested")
        return Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid);
      return Effect.void;
    }),
    Effect.forkScoped,
  );
  const session = (
    status: "running" | "ready" | "error" | "interrupted",
    target = input.threadId,
    active = turnId,
  ) =>
    engine.dispatch({
      type: "thread.session.set",
      commandId: id(),
      threadId: target,
      session: {
        threadId: target,
        status,
        providerName: "codex",
        providerInstanceId: input.modelSelection.instanceId,
        runtimeMode: "approval-required",
        activeTurnId: status === "running" ? active : null,
        lastError: status === "error" ? "provider failure" : null,
        updatedAt: now,
      },
      createdAt: now,
    });
  const message = (text: string, selectedTurn = turnId, streaming = false) =>
    Effect.gen(function* () {
      const messageId = MessageId.make(`answer-${++seq}`);
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: id(),
        threadId: input.threadId,
        messageId,
        turnId: selectedTurn,
        delta: text,
        createdAt: now,
      });
      if (!streaming)
        yield* engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: id(),
          threadId: input.threadId,
          messageId,
          turnId: selectedTurn,
          createdAt: now,
        });
    });
  return { engine, requested, interrupted, session, message, id };
});

for (const order of ["message-first", "terminal-first"] as const) {
  it.effect(
    `uses real persisted turn correlation and waits for both result and completion (${order})`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const s = yield* setup;
          const started = yield* Deferred.make<void>();
          const fiber = yield* execute({
            ...input,
            onTurnStarted: (reference) =>
              Effect.gen(function* () {
                assert.equal(reference.turnId, turnId);
                yield* Deferred.succeed(started, undefined);
              }),
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(s.requested);
          yield* s.session("running");
          yield* Deferred.await(started);
          yield* s.message("A commentary message is not the result.");
          yield* s.message('{"text":"wrong turn"}', TurnId.make("unrelated-turn"));
          assert.equal(fiber.pollUnsafe(), undefined);
          if (order === "message-first") yield* s.message('{"text":"analysis result"}');
          else yield* s.session("ready");
          assert.equal(fiber.pollUnsafe(), undefined);
          if (order === "message-first") yield* s.session("ready");
          else yield* s.message('{"text":"analysis result"}');
          const result = yield* Fiber.join(fiber);
          assert.deepEqual(result, {
            execution: { threadId: input.threadId, turnId, commandId: input.commandId },
            text: "analysis result",
          });
          const replay = yield* execute(input).pipe(Effect.flip);
          assert.equal(replay.reason, "ambiguous_replay");
        }),
      ).pipe(Effect.provide(layer)),
  );
}

it.effect("rejects scope before dispatch and bounds the prompt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup;
      const before = yield* s.engine.latestSequence;
      const denied = yield* execute(input).pipe(
        Effect.provideService(AxisProjectScope, {
          resolve: () =>
            Effect.fail(
              new AxisProjectScopeResolutionError({
                reason: "provider_not_accessible",
                message: "denied",
              }),
            ),
          resolveProject: (request) => Effect.succeed(request),
        }),
        Effect.flip,
      );
      assert.equal(denied.reason, "scope_denied");
      const oversized = yield* execute({
        ...input,
        prompt: "x".repeat(MAX_EXECUTION_TEXT_LENGTH + 1),
      }).pipe(Effect.flip);
      assert.equal(oversized.reason, "invalid_input");
      assert.equal(yield* s.engine.latestSequence, before);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("reports provider start failure using the request message id", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup;
      const fiber = yield* execute(input).pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(s.requested);
      yield* s.engine.dispatch({
        type: "thread.activity.append",
        commandId: s.id(),
        threadId: input.threadId,
        activity: {
          id: EventId.make("start-failed"),
          kind: "provider.turn.start.failed",
          tone: "error",
          summary: "failed",
          turnId: null,
          payload: { requestId: `axis-execution:${input.commandId}` },
          createdAt: now,
        },
        createdAt: now,
      });
      assert.equal((yield* Fiber.join(fiber)).reason, "provider_failed");
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect(
  "fiber cancellation dispatches interruption and waits for the dedicated turn to stop",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup;
        const started = yield* Deferred.make<void>();
        const fiber = yield* execute({
          ...input,
          onTurnStarted: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(s.requested);
        yield* s.session("running");
        yield* Deferred.await(started);
        const cancellation = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
        yield* Deferred.await(s.interrupted);
        assert.equal(cancellation.pollUnsafe(), undefined);
        yield* s.session("interrupted");
        yield* Fiber.join(cancellation);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("unconfirmed cancellation finishes with an explicit error after its deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup;
      const fiber = yield* execute(input).pipe(Effect.forkScoped);
      yield* Deferred.await(s.requested);
      const cancellation = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
      yield* Deferred.await(s.interrupted);
      yield* TestClock.adjust(CANCELLATION_TIMEOUT_MS);
      yield* Fiber.join(cancellation);
      const exit = yield* Fiber.await(fiber);
      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.findErrorOption(exit.cause);
        assert.equal(Option.isSome(error) && error.value.reason, "cancel_failed");
      }
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("invalid final output reaches an explicit bounded deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup;
      const fiber = yield* execute(input).pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(s.requested);
      yield* s.session("running");
      yield* s.message("not a result envelope");
      yield* s.session("ready");
      yield* TestClock.adjust(EXECUTION_TIMEOUT_MS);
      assert.equal((yield* Fiber.join(fiber)).reason, "invalid_output");
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("cancelling an older attempt cannot target the retry thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup;
      const retryThread = ThreadId.make("attempt-two");
      const retryTurn = TurnId.make("provider-turn-two");
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const first = yield* execute({
        ...input,
        onTurnStarted: () => Deferred.succeed(firstStarted, undefined).pipe(Effect.asVoid),
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(s.requested);
      yield* s.session("running");
      yield* Deferred.await(firstStarted);
      const eventStream = yield* s.engine.subscribeDomainEvents;
      const retryRequested = yield* Deferred.make<void>();
      yield* eventStream.pipe(
        Stream.filter(
          (e) => e.type === "thread.turn-start-requested" && e.payload.threadId === retryThread,
        ),
        Stream.take(1),
        Stream.runForEach(() => Deferred.succeed(retryRequested, undefined)),
        Effect.forkScoped,
      );
      const second = yield* execute({
        ...input,
        threadId: retryThread,
        commandId: CommandId.make("execute-two"),
        onTurnStarted: () => Deferred.succeed(secondStarted, undefined).pipe(Effect.asVoid),
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(retryRequested);
      yield* s.session("running", retryThread, retryTurn);
      yield* Deferred.await(secondStarted);
      const stopping = yield* Fiber.interrupt(first).pipe(Effect.forkScoped);
      yield* Deferred.await(s.interrupted);
      yield* s.session("interrupted");
      yield* Fiber.join(stopping);
      assert.equal(second.pollUnsafe(), undefined);
      const head = yield* s.engine.latestSequence;
      const retryEvents = yield* s.engine
        .readThreadEvents({
          threadId: retryThread,
          fromSequenceExclusive: 0,
          toSequenceInclusive: head,
        })
        .pipe(Stream.runCollect);
      assert.equal(
        retryEvents.some((e) => e.type === "thread.turn-interrupt-requested"),
        false,
      );
      const resultMessage = MessageId.make("retry-result");
      yield* s.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: s.id(),
        threadId: retryThread,
        messageId: resultMessage,
        turnId: retryTurn,
        delta: '{"text":"retry result"}',
        createdAt: now,
      });
      yield* s.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: s.id(),
        threadId: retryThread,
        messageId: resultMessage,
        turnId: retryTurn,
        createdAt: now,
      });
      yield* s.session("ready", retryThread, retryTurn);
      assert.equal((yield* Fiber.join(second)).text, "retry result");
    }),
  ).pipe(Effect.provide(layer)),
);

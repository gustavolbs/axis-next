import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AxisContextProjectScope,
  AxisOnboardingDecision,
  CommandId,
  MessageId,
  ProviderInstanceId,
  TurnId,
  type AxisOnboardingRun,
  type OrchestrationEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

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
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as AxisProjectProfileStore from "../projects/AxisProjectProfileStore.ts";
import { AxisProjectScope, AxisProjectScopeResolutionError } from "../projects/AxisProjectScope.ts";
import * as AxisTaskExecution from "../tasks/AxisTaskExecution.ts";
import { AxisOnboardingApplyError } from "./AxisOnboardingApply.ts";
import * as AxisOnboardingService from "./AxisOnboardingService.ts";
import * as AxisOnboardingStore from "./AxisOnboardingStore.ts";
import * as AxisProjectSources from "./AxisProjectSources.ts";

const scope = Schema.decodeUnknownSync(AxisContextProjectScope)({
  contextId: "personal",
  project: { environmentId: "environment", projectId: "project" },
});
const startInput = {
  scope,
  commandId: CommandId.make("command-onboarding"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
};
const now = "2026-09-10T00:00:00.000Z";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeDecision = Schema.decodeUnknownSync(AxisOnboardingDecision);
const inventory: AxisProjectSources.AxisProjectSourcesResult = {
  workspaceRoot: process.cwd(),
  sources: [
    {
      path: "package.json",
      kind: "manifest",
      status: "read",
      content: '{"scripts":{"test":"vp test run"}}',
      byteLength: 34,
      truncated: false,
      error: null,
    },
  ],
  fileCount: 1,
  byteCount: 34,
  truncated: false,
};
type TurnRequested = Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;
type TurnInterrupted = Extract<OrchestrationEvent, { type: "thread.turn-interrupt-requested" }>;

const infrastructure = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  ProjectionTurnRepositoryLive,
  AxisOnboardingStore.layer,
  AxisProjectProfileStore.layer,
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "axis-onboarding-service-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    Layer.succeed(AxisProjectScope, {
      resolve: (request) => Effect.succeed(request),
      resolveProject: (request) => Effect.succeed(request),
    }),
  ),
);
const layer = AxisTaskExecution.layer.pipe(Layer.provideMerge(infrastructure));

const setup = Effect.fn("setup")(function* (
  options: { holdInterrupt?: boolean; denyScope?: boolean; truncatedManifest?: boolean } = {},
) {
  const engine = yield* OrchestrationEngineService;
  const runs = yield* AxisOnboardingStore.AxisOnboardingStore;
  const profiles = yield* AxisProjectProfileStore.AxisProjectProfileStore;
  const turns = yield* ProjectionTurnRepository;
  const collected = yield* Deferred.make<void>();
  const allowCollect = yield* Deferred.make<void>();
  const allowInterrupt = yield* Deferred.make<void>();
  const terminal = yield* Queue.unbounded<AxisOnboardingRun>();
  const linked = yield* Queue.unbounded<AxisOnboardingRun>();
  const requested = yield* Queue.unbounded<TurnRequested>();
  const interrupted = yield* Queue.unbounded<TurnInterrupted>();
  const requests: TurnRequested[] = [];
  const interrupts: TurnInterrupted[] = [];
  let collectCount = 0;
  let sequence = 0;
  const id = () => CommandId.make(`provider-command-${++sequence}`);
  const providerTurn = (threadId: ThreadId) => TurnId.make(`provider-${threadId}`);
  const session = (threadId: ThreadId, status: "running" | "ready" | "interrupted") =>
    engine.dispatch({
      type: "thread.session.set",
      commandId: id(),
      threadId,
      session: {
        threadId,
        status,
        providerName: "codex",
        providerInstanceId: startInput.modelSelection.instanceId,
        runtimeMode: "approval-required",
        activeTurnId: status === "running" ? providerTurn(threadId) : null,
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    });
  yield* engine.dispatch({
    type: "project.create",
    commandId: id(),
    projectId: scope.project.projectId,
    title: "Onboarding project",
    workspaceRoot: process.cwd(),
    defaultModelSelection: startInput.modelSelection,
    createdAt: now,
  });
  const events = yield* engine.subscribeDomainEvents;
  // Fake only the provider boundary: starts and interrupts are persisted T3
  // commands, and responses update the real engine and canonical projections.
  yield* events.pipe(
    Stream.runForEach(
      Effect.fn(function* (event) {
        if (event.type === "thread.turn-start-requested") {
          requests.push(event);
          yield* session(event.payload.threadId, "running");
          yield* Queue.offer(requested, event);
        }
        if (event.type === "thread.turn-interrupt-requested") {
          interrupts.push(event);
          yield* Queue.offer(interrupted, event);
          if (options.holdInterrupt) yield* Deferred.await(allowInterrupt);
          yield* session(event.payload.threadId, "interrupted");
        }
      }),
    ),
    Effect.forkScoped,
  );
  const makeService = AxisOnboardingService.make.pipe(
    Effect.provideService(AxisOnboardingStore.AxisOnboardingStore, {
      ...runs,
      // Instrument a committed write; keep every store operation backed by SQLite.
      save: (run) =>
        runs
          .save(run)
          .pipe(
            Effect.andThen(
              run.status === "completed" || run.status === "failed"
                ? Queue.offer(terminal, run).pipe(Effect.asVoid)
                : run.status === "running" && run.execution.turnId !== null
                  ? Queue.offer(linked, run).pipe(Effect.asVoid)
                  : Effect.void,
            ),
          ),
    }),
    Effect.provideService(AxisProjectSources.AxisProjectSources, {
      collect: (request) =>
        Effect.gen(function* () {
          assert.deepEqual(request.scope, scope);
          assert.deepEqual(request.provider, {
            environmentId: scope.project.environmentId,
            instanceId: startInput.modelSelection.instanceId,
          });
          collectCount += 1;
          yield* Deferred.succeed(collected, undefined);
          yield* Deferred.await(allowCollect);
          return options.truncatedManifest
            ? {
                ...inventory,
                sources: inventory.sources.map((source) => ({ ...source, truncated: true })),
              }
            : inventory;
        }),
    }),
    Effect.provideService(AxisProjectScope, {
      resolveProject: (request) => Effect.succeed(request),
      resolve: (request) =>
        options.denyScope
          ? Effect.fail(
              new AxisProjectScopeResolutionError({
                reason: "provider_not_accessible",
                message: "Provider denied",
              }),
            )
          : Effect.succeed(request),
    }),
  );
  const service = yield* makeService;
  yield* Effect.addFinalizer(() => Deferred.succeed(allowInterrupt, undefined));
  const finish = Effect.fn("finish")(function* (
    run: AxisOnboardingRun,
    text = '{"candidates":[]}',
  ) {
    const threadId = run.execution.threadId;
    const turnId = providerTurn(threadId);
    const messageId = MessageId.make(`result-${threadId}`);
    yield* engine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: id(),
      threadId,
      turnId,
      messageId,
      delta: encodeJson({ text }),
      createdAt: now,
    });
    yield* engine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: id(),
      threadId,
      turnId,
      messageId,
      createdAt: now,
    });
    yield* session(threadId, "ready");
    const completed = yield* Queue.take(terminal);
    assert.equal(completed.status, "completed", completed.error ?? undefined);
    return completed;
  });
  return {
    service,
    makeService,
    runs,
    profiles,
    turns,
    engine,
    requested,
    interrupted,
    terminal,
    collected,
    linked,
    allowCollect,
    allowInterrupt,
    requests,
    interrupts,
    finish,
    providerTurn,
    collectCount: () => collectCount,
  };
});

for (const apply of [false, true])
  it.effect(
    apply
      ? "applies reviewed sources/facts through the Service with SQLite foreign keys enabled"
      : "persists canonical execution and returns it after reload without activating candidates",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const s = yield* setup();
          const started = yield* s.service.start(startInput);
          assert.equal(started.progress.stage, "collecting");
          assert.equal(started.run.execution.turnId, null);
          yield* Deferred.await(s.collected);
          yield* Deferred.succeed(s.allowCollect, undefined);
          const request = yield* Queue.take(s.requested);
          assert.equal(request.commandId, startInput.commandId);
          assert.equal(request.payload.threadId, started.run.execution.threadId);
          assert.deepEqual(request.payload.modelSelection, startInput.modelSelection);
          assert.equal(request.payload.runtimeMode, "approval-required");
          const linked = yield* Queue.take(s.linked);
          assert.equal(linked.execution.turnId, s.providerTurn(started.run.execution.threadId));
          const during = yield* s.service.get(scope, started.run.id);
          assert.equal(during.run.execution.turnId, linked.execution.turnId);
          assert.equal(during.progress.stage, "analyzing");
          assert.equal(during.run.sources.length, 1);
          assert.isAbove(during.run.facts.length, 0);
          const observed = (yield* s.turns.listByThreadId({
            threadId: started.run.execution.threadId,
          }))[0]!;
          assert.equal(observed.pendingMessageId, `axis-execution:${startInput.commandId}`);
          assert.equal(observed.turnId, s.providerTurn(started.run.execution.threadId));
          const completed = yield* s.finish(
            during.run,
            encodeJson({
              candidates: [
                {
                  category: "test-policy",
                  text: "Run vp test run for focused tests.",
                  effect: "preference",
                  sourceIds: [during.run.sources[0]!.id],
                  factIds: [during.run.facts[0]!.id],
                },
              ],
            }),
          );
          assert.equal(completed.execution.turnId, observed.turnId);
          assert.deepEqual(completed.modelSelection, startInput.modelSelection);
          assert.equal(completed.candidateRules.length, 1);
          const before = yield* s.profiles.get(scope);
          assert.equal(before.revision, 0);
          assert.deepEqual(before.rules, []);
          const reloaded = yield* s.makeService;
          const duplicate = yield* reloaded.start(startInput);
          assert.equal(duplicate.run.status, "completed");
          assert.equal(duplicate.run.execution.turnId, observed.turnId);
          assert.equal(s.requests.length, 1);
          if (!apply) return;
          assert.equal(duplicate.applied, false);
          const applied = yield* s.service.apply({
            scope,
            runId: completed.id,
            expectedProfileRevision: before.revision,
            decisions: [
              decodeDecision({
                id: "decision-test",
                candidateRuleId: completed.candidateRules[0]!.id,
                decision: "accept",
                note: null,
              }),
            ],
            commandId: CommandId.make("apply-onboarding"),
          });
          assert.equal(applied.profile.revision, 1);
          assert.equal(applied.run.applied, true);
          assert.equal((yield* reloaded.get(scope, completed.id)).applied, true);
          assert.equal(
            (yield* reloaded.list(scope)).find((item) => item.run.id === completed.id)?.applied,
            true,
          );
          assert.equal((yield* reloaded.start(startInput)).applied, true);
          assert.equal(applied.profile.sources[0]?.path, "package.json");
          assert.equal(applied.profile.facts.length, completed.facts.length);
          assert.equal(applied.profile.rules[0]?.text, completed.candidateRules[0]!.text);
          assert.equal(applied.profile.manualDecisions[0]?.decision, "accept");
          assert.deepEqual(yield* s.profiles.get(scope), applied.profile);
          const persisted = Option.getOrThrow(yield* s.runs.get(scope, completed.id));
          assert.deepEqual(persisted.decisions, applied.run.run.decisions);
        }),
      ).pipe(Effect.provide(layer)),
  );

it.effect("reports manifest limitations while analysis runs without structured facts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup({ truncatedManifest: true });
      const started = yield* s.service.start(startInput);
      yield* Deferred.await(s.collected);
      yield* Deferred.succeed(s.allowCollect, undefined);
      yield* Queue.take(s.requested);
      const during = yield* s.service.get(scope, started.run.id);
      assert.equal(during.progress.stage, "analyzing");
      assert.equal(during.run.facts.length, 0);
      assert.include(during.run.sources[0]?.warning ?? "", "truncated");
      const completed = yield* s.finish(during.run, encodeJson({ candidates: [] }));
      assert.equal(completed.status, "completed");
      assert.deepEqual(completed.candidateRules, []);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("concurrent duplicate starts collect and dispatch exactly once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup();
      const results = yield* Effect.all(
        [s.service.start(startInput), s.service.start(startInput)],
        { concurrency: "unbounded" },
      );
      assert.equal(results[0].run.id, results[1].run.id);
      yield* Deferred.await(s.collected);
      assert.equal(s.collectCount(), 1);
      yield* Deferred.succeed(s.allowCollect, undefined);
      yield* Queue.take(s.requested);
      yield* s.finish(results[0].run);
      assert.equal(s.requests.length, 1);
      assert.equal((yield* s.service.list(scope)).length, 1);
    }),
  ).pipe(Effect.provide(layer)),
);

for (const replayCancel of [false, true])
  it.effect(
    replayCancel
      ? "replaying an old cancel cannot interrupt the retry"
      : "cancel waits for provider interruption and retry completes on a fresh thread",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const s = yield* setup({ holdInterrupt: true });
          const started = yield* s.service.start(startInput);
          yield* Deferred.succeed(s.allowCollect, undefined);
          yield* Queue.take(s.requested);
          const cancellation = {
            runId: started.run.id,
            commandId: CommandId.make("cancel-onboarding"),
            reason: "Stop analysis",
          };
          const cancelFiber = yield* s.service.cancel(scope, cancellation).pipe(Effect.forkScoped);
          const interrupt = yield* Queue.take(s.interrupted);
          assert.equal(interrupt.payload.threadId, started.run.execution.threadId);
          assert.equal(cancelFiber.pollUnsafe(), undefined);
          const retryInput = {
            runId: started.run.id,
            commandId: CommandId.make("retry-onboarding"),
          };
          const stopping = yield* s.service.retry(scope, retryInput).pipe(Effect.flip);
          assert.instanceOf(stopping, AxisOnboardingService.AxisOnboardingServiceValidationError);
          yield* Deferred.succeed(s.allowInterrupt, undefined);
          assert.equal((yield* Fiber.join(cancelFiber)).run.status, "cancelled");
          const oldRows = yield* s.turns.listByThreadId({
            threadId: started.run.execution.threadId,
          });
          assert.equal(oldRows[0]?.state, "interrupted");
          const retried = yield* s.service.retry(scope, retryInput);
          assert.notEqual(retried.run.execution.threadId, started.run.execution.threadId);
          assert.equal(retried.run.execution.turnId, null);
          assert.equal(retried.run.execution.commandId, retryInput.commandId);
          const next = yield* Queue.take(s.requested);
          assert.equal(next.payload.threadId, retried.run.execution.threadId);
          assert.equal(next.commandId, retryInput.commandId);
          if (replayCancel) {
            const replay = yield* s.service.cancel(scope, cancellation);
            assert.equal(replay.run.status, "running");
            // The cancel ledger returns the current run on replay; this must not
            // dispatch another provider interrupt against the new attempt.
            assert.equal(
              s.interrupts.length,
              1,
              "replaying the old cancel must not interrupt the retry",
            );
          }
          const completed = yield* s.finish(retried.run);
          assert.equal(completed.execution.turnId, s.providerTurn(retried.run.execution.threadId));
          assert.equal(s.requests.length, 2);
          assert.equal(s.interrupts.length, 1);
        }),
      ).pipe(Effect.provide(layer)),
  );

it.effect("rejects apply before completion and after cancellation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup();
      const started = yield* s.service.start(startInput);
      const applyInput = {
        scope,
        runId: started.run.id,
        expectedProfileRevision: 0,
        decisions: [],
        commandId: CommandId.make("apply-incomplete"),
      };
      const incomplete = yield* s.service.apply(applyInput).pipe(Effect.flip);
      assert.instanceOf(incomplete, AxisOnboardingApplyError);
      yield* s.service.cancel(scope, {
        runId: started.run.id,
        commandId: CommandId.make("cancel-before-provider"),
        reason: "Stop collecting",
      });
      const cancelled = yield* s.service
        .apply({ ...applyInput, commandId: CommandId.make("apply-cancelled") })
        .pipe(Effect.flip);
      assert.instanceOf(cancelled, AxisOnboardingApplyError);
      assert.equal((yield* s.profiles.get(scope)).revision, 0);
      assert.equal(s.requests.length, 0);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("provider scope denial settles failure before collection or T3 dispatch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup({ denyScope: true });
      const head = yield* s.engine.latestSequence;
      const started = yield* s.service.start(startInput);
      const failed = yield* Queue.take(s.terminal);
      assert.equal(failed.id, started.run.id);
      assert.equal(failed.status, "failed");
      assert.equal(s.collectCount(), 0);
      assert.equal(yield* s.engine.latestSequence, head);
      assert.equal(s.requests.length, 0);
    }),
  ).pipe(Effect.provide(layer)),
);

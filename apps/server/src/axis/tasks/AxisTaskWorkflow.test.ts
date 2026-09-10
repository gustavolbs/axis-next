import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AxisTaskExtension,
  AxisTaskStepId,
  AxisSkillId,
  CommandId,
  EventId,
  MessageId,
  ProviderInstanceId,
  TurnId,
  type ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
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
import { AxisProjectScope } from "../projects/AxisProjectScope.ts";
import * as Execution from "./AxisTaskExecution.ts";
import * as Workflow from "./AxisTaskWorkflow.ts";

const now = "2026-09-10T12:00:00.000Z";
const task = Schema.decodeUnknownSync(AxisTaskExtension)({
  id: "task-one",
  scope: { contextId: "personal", project: { environmentId: "env", projectId: "project" } },
  threadId: "task-conversation",
  title: "Analyze the parser",
  acceptanceCriteria: [{ id: "criterion", text: "Describe malformed input handling." }],
  workflowVersion: "v1",
  status: "active",
  revision: 0,
  createdAt: now,
  updatedAt: now,
  steps: [
    {
      id: "analysis",
      skillId: "intake",
      status: "not-executed",
      turnId: null,
      commandId: null,
      reason: null,
      startedAt: null,
      finishedAt: null,
    },
  ],
});
const input: Workflow.WorkflowRequest = {
  task,
  stepId: AxisTaskStepId.make("analysis"),
  commandId: CommandId.make("dispatch-analysis"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
};
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const infrastructure = Layer.mergeAll(
  OrchestrationEngineLive.pipe(Layer.provide(OrchestrationProjectionPipelineLive)),
  ProjectionTurnRepositoryLive,
).pipe(
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "axis-workflow-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    Layer.succeed(AxisProjectScope, {
      resolve: (request) => Effect.succeed(request),
      resolveProject: (request) => Effect.succeed(request),
    }),
  ),
);
const layer = Execution.layer.pipe(Layer.provideMerge(infrastructure));
type Requested = Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;

const setup = Effect.fn("workflowTest.setup")(function* (holdInterrupt = false) {
  const engine = yield* OrchestrationEngineService;
  const executor = yield* Execution.AxisTaskExecution;
  const workflow = yield* Workflow.make;
  const requested = yield* Queue.unbounded<Requested>();
  const interrupted = yield* Deferred.make<ThreadId>();
  const allowInterrupt = yield* Deferred.make<void>();
  let sequence = 0;
  const commands: Requested[] = [];
  const id = () => CommandId.make(`provider-${++sequence}`);
  const turnId = (request: Workflow.WorkflowRequest) => TurnId.make(`turn-${request.commandId}`);
  const session = (
    request: Workflow.WorkflowRequest,
    status: "running" | "ready" | "error" | "interrupted" | "stopped",
  ) => {
    const threadId = Workflow.attemptThreadId(request);
    return engine.dispatch({
      type: "thread.session.set",
      commandId: id(),
      threadId,
      createdAt: now,
      session: {
        threadId,
        status,
        providerName: "codex",
        providerInstanceId: request.modelSelection.instanceId,
        runtimeMode: "approval-required",
        activeTurnId: status === "running" ? turnId(request) : null,
        lastError: status === "error" ? "Provider rejected request" : null,
        updatedAt: now,
      },
    });
  };
  yield* engine.dispatch({
    type: "project.create",
    commandId: id(),
    projectId: task.scope.project.projectId,
    title: "Workflow test",
    workspaceRoot: process.cwd(),
    defaultModelSelection: input.modelSelection,
    createdAt: now,
  });
  const events = yield* engine.subscribeDomainEvents;
  yield* events.pipe(
    Stream.runForEach(
      Effect.fn(function* (event) {
        if (event.type === "thread.turn-start-requested") {
          commands.push(event);
          yield* Queue.offer(requested, event);
        }
        if (event.type === "thread.turn-interrupt-requested") {
          yield* Deferred.succeed(interrupted, event.payload.threadId);
          if (holdInterrupt) yield* Deferred.await(allowInterrupt);
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: id(),
            threadId: event.payload.threadId,
            createdAt: now,
            session: {
              threadId: event.payload.threadId,
              status: "interrupted",
              providerName: "codex",
              providerInstanceId: input.modelSelection.instanceId,
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: now,
            },
          });
        }
      }),
    ),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() => Deferred.succeed(allowInterrupt, undefined));
  const message = Effect.fn("workflowTest.message")(function* (
    request: Workflow.WorkflowRequest,
    text: string,
    envelope = true,
  ) {
    const threadId = Workflow.attemptThreadId(request);
    const messageId = MessageId.make(`result-${request.commandId}`);
    yield* engine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: id(),
      threadId,
      messageId,
      turnId: turnId(request),
      delta: envelope ? encode({ text }) : text,
      createdAt: now,
    });
    yield* engine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: id(),
      threadId,
      messageId,
      turnId: turnId(request),
      createdAt: now,
    });
    return messageId;
  });
  const activity = (kind: string) =>
    engine.dispatch({
      type: "thread.activity.append",
      commandId: id(),
      threadId: Workflow.attemptThreadId(input),
      createdAt: now,
      activity: {
        id: EventId.make(`activity-${++sequence}`),
        kind,
        tone: "info",
        summary: kind,
        payload: { requestId: "request-one", requestKind: "command", questions: [] },
        turnId: turnId(input),
        createdAt: now,
      },
    });
  return {
    engine,
    executor,
    workflow,
    requested,
    interrupted,
    allowInterrupt,
    commands,
    session,
    message,
    activity,
    id,
    turnId,
  };
});

it.effect(
  "accepted is not completed; analysis and plan require canonical documents on dedicated threads",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup();
        const fiber = yield* s.workflow.dispatch(input).pipe(Effect.forkScoped);
        const requested = yield* Queue.take(s.requested);
        assert.equal(requested.commandId, input.commandId);
        assert.notEqual(requested.payload.threadId, task.threadId);
        const accepted = yield* s.workflow.getState(input);
        assert.equal(accepted.status, "accepted");
        assert.equal(accepted.execution.turnId, null);
        assert.equal(accepted.artifact, null);
        const replay = yield* s.workflow.dispatch(input).pipe(Effect.flip);
        assert.equal(replay.reason, "ambiguous_replay");
        yield* s.session(input, "running");
        assert.equal((yield* s.workflow.getState(input)).status, "running");
        const messageId = yield* s.message(
          input,
          "Objective: analyze the parser. Scope: malformed inputs. Criteria: describe handling.",
        );
        assert.equal((yield* s.workflow.getState(input)).status, "running");
        yield* s.session(input, "ready");
        const completed = yield* Fiber.join(fiber);
        assert.equal(completed.status, "completed");
        assert.equal(completed.artifact?.messageId, messageId);
        assert.equal(completed.artifact?.execution.turnId, s.turnId(input));
        assert.equal(s.commands.length, 1);
        const reloaded = yield* Workflow.make;
        assert.deepEqual(yield* reloaded.getState(input), completed);
        yield* s.session(input, "stopped");
        assert.deepEqual(yield* reloaded.getState(input), completed);
        assert.equal(
          (yield* reloaded.getState({
            ...input,
            task: { ...task, title: "A different objective" },
          })).status,
          "validation-pending",
        );
        assert.equal(
          (yield* reloaded.getState({
            ...input,
            task: { ...task, steps: [{ ...task.steps[0]!, skillId: AxisSkillId.make("plan") }] },
          })).status,
          "validation-pending",
        );
        const plan: Workflow.WorkflowRequest = {
          ...input,
          stepId: AxisTaskStepId.make("plan"),
          commandId: CommandId.make("dispatch-plan"),
          task: {
            ...task,
            steps: [
              {
                ...task.steps[0]!,
                status: "completed",
                turnId: completed.execution.turnId,
                commandId: input.commandId,
              },
              {
                ...task.steps[0]!,
                id: AxisTaskStepId.make("plan"),
                skillId: AxisSkillId.make("plan"),
              },
            ],
          },
        };
        const planFiber = yield* s.workflow
          .dispatch(plan, (commandId) =>
            Effect.succeed(commandId === input.commandId ? Option.some(input) : Option.none()),
          )
          .pipe(Effect.forkScoped);
        const planRequested = yield* Queue.take(s.requested);
        assert.notEqual(planRequested.payload.threadId, requested.payload.threadId);
        yield* s.session(plan, "running");
        yield* s.message(
          plan,
          "Implementation plan: validate malformed input. Verification plan: add and run focused tests later.",
        );
        yield* s.session(plan, "ready");
        const planned = yield* Fiber.join(planFiber);
        assert.equal(planned.status, "completed");
        assert.equal(planned.artifact?.skillId, "plan");
        assert.equal(s.commands.length, 2);
      }),
    ).pipe(Effect.provide(layer)),
);

for (const requestKind of ["approval", "user-input"])
  it.effect(`projects ${requestKind} waiting separately from provider failure`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup();
        const fiber = yield* s.workflow.dispatch(input).pipe(Effect.flip, Effect.forkScoped);
        yield* Queue.take(s.requested);
        yield* s.session(input, "running");
        yield* s.activity(`${requestKind}.requested`);
        assert.equal((yield* s.workflow.getState(input)).status, "waiting-input");
        assert.equal(fiber.pollUnsafe(), undefined);
        yield* s.activity(`${requestKind}.resolved`);
        assert.equal((yield* s.workflow.getState(input)).status, "running");
        yield* s.session(input, "error");
        assert.equal((yield* Fiber.join(fiber)).reason, "provider_failed");
        assert.equal((yield* s.workflow.getState(input)).status, "failed");
      }),
    ).pipe(Effect.provide(layer)),
  );

it.effect("recognizes provider-confirmed interruption before a pending turn starts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup(true);
      const attempt = yield* s.workflow.dispatch(input).pipe(Effect.forkScoped);
      yield* Queue.take(s.requested);
      assert.equal((yield* s.workflow.getState(input)).status, "accepted");
      const cancellation = yield* Fiber.interrupt(attempt).pipe(Effect.forkScoped);
      assert.equal(yield* Deferred.await(s.interrupted), Workflow.attemptThreadId(input));
      yield* Deferred.succeed(s.allowInterrupt, undefined);
      yield* Fiber.join(cancellation);
      const interrupted = yield* s.workflow.getState(input);
      assert.equal(interrupted.status, "interrupted");
      assert.equal(interrupted.execution.turnId, null);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect(
  "fiber interruption waits for the provider and retry has a fresh canonical identity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup(true);
        const first = yield* s.workflow.dispatch(input).pipe(Effect.forkScoped);
        yield* Queue.take(s.requested);
        yield* s.session(input, "running");
        const prematureRetry = {
          ...input,
          commandId: CommandId.make("premature-retry"),
          task: { ...task, steps: [{ ...task.steps[0]!, commandId: input.commandId }] },
        };
        assert.equal((yield* s.workflow.dispatch(prematureRetry)).status, "blocked");
        const cancellation = yield* Fiber.interrupt(first).pipe(Effect.forkScoped);
        assert.equal(yield* Deferred.await(s.interrupted), Workflow.attemptThreadId(input));
        assert.equal(cancellation.pollUnsafe(), undefined);
        yield* Deferred.succeed(s.allowInterrupt, undefined);
        yield* Fiber.join(cancellation);
        assert.equal((yield* s.workflow.getState(input)).status, "interrupted");
        const retry = { ...prematureRetry, commandId: CommandId.make("analysis-retry") };
        const next = yield* s.workflow
          .dispatch(retry, (commandId) =>
            Effect.succeed(commandId === input.commandId ? Option.some(input) : Option.none()),
          )
          .pipe(Effect.forkScoped);
        yield* Queue.take(s.requested);
        assert.notEqual(Workflow.attemptThreadId(retry), Workflow.attemptThreadId(input));
        yield* s.session(retry, "running");
        yield* s.message(retry, "Analysis document from the retry.");
        yield* s.session(retry, "ready");
        assert.equal((yield* Fiber.join(next)).status, "completed");
        assert.equal((yield* s.workflow.getState(input)).status, "interrupted");
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect(
  "blocks diff/test/review/PR stages before dispatch and refuses reasonless skips or forged prerequisites",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup();
        const head = yield* s.engine.latestSequence;
        for (const skill of ["implement", "verify", "self-review", "prepare-pr", "publish"]) {
          const result = yield* s.workflow.dispatch({
            ...input,
            task: { ...task, steps: [{ ...task.steps[0]!, skillId: AxisSkillId.make(skill) }] },
          });
          assert.equal(result.status, "blocked");
          assert.isNotNull(result.reason);
          assert.equal(result.artifact, null);
        }
        const skipped = {
          ...input,
          task: { ...task, steps: [{ ...task.steps[0]!, status: "not-applicable" as const }] },
        };
        assert.equal((yield* s.workflow.dispatch(skipped)).status, "blocked");
        assert.equal(
          (yield* s.workflow.dispatch({
            ...skipped,
            task: {
              ...task,
              steps: [{ ...skipped.task.steps[0]!, reason: "No input migration applies." }],
            },
          })).status,
          "not-applicable",
        );
        const later = {
          ...input,
          stepId: AxisTaskStepId.make("plan"),
          task: {
            ...task,
            steps: [
              {
                ...task.steps[0]!,
                status: "completed" as const,
                commandId: CommandId.make("fabricated-command"),
              },
              {
                ...task.steps[0]!,
                id: AxisTaskStepId.make("plan"),
                skillId: AxisSkillId.make("plan"),
              },
            ],
          },
        };
        assert.equal((yield* s.workflow.dispatch(later)).status, "blocked");
        assert.equal(yield* s.engine.latestSequence, head);
        assert.equal(s.commands.length, 0);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("a real completed turn claiming tests passed cannot satisfy verification evidence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup();
      const verification = {
        ...input,
        task: { ...task, steps: [{ ...task.steps[0]!, skillId: AxisSkillId.make("verify") }] },
      };
      const fiber = yield* s.executor
        .execute({
          scope: task.scope,
          threadId: Workflow.attemptThreadId(verification),
          commandId: input.commandId,
          modelSelection: input.modelSelection,
          prompt: "Describe verification findings.",
        })
        .pipe(Effect.forkScoped);
      yield* Queue.take(s.requested);
      yield* s.session(verification, "running");
      yield* s.message(verification, "I ran the tests; all passed.");
      yield* s.session(verification, "ready");
      yield* Fiber.join(fiber);
      const state = yield* s.workflow.getState(verification);
      assert.equal(state.status, "validation-pending");
      assert.equal(state.artifact, null);
      assert.include(state.reason!, "command/exit-code evidence");
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("completed turns without the document envelope remain validation-pending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup();
      const fiber = yield* s.workflow.dispatch(input).pipe(Effect.flip, Effect.forkScoped);
      yield* Queue.take(s.requested);
      yield* s.session(input, "running");
      yield* s.message(input, "Plain commentary with no result envelope", false);
      yield* s.session(input, "ready");
      assert.equal((yield* s.workflow.getState(input)).status, "validation-pending");
      yield* TestClock.adjust(Execution.EXECUTION_TIMEOUT_MS);
      assert.equal((yield* Fiber.join(fiber)).reason, "invalid_output");
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("orphan thread history is unknown and cannot be replayed after a restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup();
      yield* s.engine.dispatch({
        type: "thread.create",
        commandId: s.id(),
        threadId: Workflow.attemptThreadId(input),
        projectId: task.scope.project.projectId,
        title: "Interrupted admission",
        modelSelection: input.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      assert.equal((yield* s.workflow.getState(input)).status, "unknown");
      assert.equal(
        (yield* s.workflow.dispatch(input).pipe(Effect.flip)).reason,
        "ambiguous_replay",
      );
      assert.equal(s.commands.length, 0);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect(
  "preparation does not execute and final admission refuses history created in the gap",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup();
        const prepared = yield* s.workflow.prepare(input);
        assert.equal(prepared.state.status, "not-executed");
        assert.isNotNull(prepared.execute);
        assert.equal(s.commands.length, 0);
        yield* s.engine.dispatch({
          type: "thread.create",
          commandId: s.id(),
          threadId: Workflow.attemptThreadId(input),
          projectId: task.scope.project.projectId,
          title: "History appeared after preflight",
          modelSelection: input.modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        });
        const failure = yield* Effect.flip(prepared.execute!);
        assert.equal(failure.reason, "ambiguous_replay");
        assert.equal(s.commands.length, 0);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("prerequisite resolver cannot substitute a different task or step", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup();
      const plan: Workflow.WorkflowRequest = {
        ...input,
        stepId: AxisTaskStepId.make("plan"),
        commandId: CommandId.make("resolver-plan"),
        task: {
          ...task,
          steps: [
            { ...task.steps[0]!, commandId: input.commandId, status: "completed" },
            {
              ...task.steps[0]!,
              id: AxisTaskStepId.make("plan"),
              skillId: AxisSkillId.make("plan"),
            },
          ],
        },
      };
      const failure = yield* Effect.flip(
        s.workflow.prepare(plan, () =>
          Effect.succeed(Option.some({ ...input, stepId: AxisTaskStepId.make("other-step") })),
        ),
      );
      assert.equal(failure.reason, "observation_failed");
      assert.equal(s.commands.length, 0);
    }),
  ).pipe(Effect.provide(layer)),
);

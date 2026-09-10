import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AxisTaskExtension,
  AxisSkillId,
  AxisTaskStepId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
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
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import Migration065 from "../../persistence/Migrations/065_AxisWorkflowAttempts.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { AxisProjectScope, AxisProjectScopeResolutionError } from "../projects/AxisProjectScope.ts";
import * as Execution from "./AxisTaskExecution.ts";
import * as Tasks from "./AxisTaskStore.ts";
import * as Workflow from "./AxisTaskWorkflow.ts";
import * as Store from "./AxisTaskWorkflowStore.ts";
import * as Service from "./AxisTaskWorkflowService.ts";

const now = "2026-09-10T12:00:00.000Z";
const decodeTask = Schema.decodeUnknownSync(AxisTaskExtension);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const caller = { contextId: "personal", environmentId: "env" } as const;
const taskFor = (id: string) =>
  decodeTask({
    id,
    scope: {
      contextId: caller.contextId,
      project: { environmentId: caller.environmentId, projectId: "project" },
    },
    threadId: `root-${id}`,
    title: "Analyze empty parser input",
    acceptanceCriteria: [{ id: "empty", text: "Explain the empty input case." }],
    workflowVersion: "1",
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
const typedCaller = {
  contextId: taskFor("caller").scope.contextId,
  environmentId: EnvironmentId.make("env"),
};
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "synthetic-model" };
const database = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'axis_workflow_attempts'`;
    // Main owns registration of 065. Exercise that real migration on test-only
    // SQLite until it is registered; no alternate schema or production writes.
    if (rows.length === 0) yield* Migration065;
  }),
).pipe(Layer.provideMerge(SqlitePersistenceMemory));
const infrastructure = Layer.mergeAll(
  OrchestrationEngineLive.pipe(Layer.provide(OrchestrationProjectionPipelineLive)),
  ProjectionTurnRepositoryLive,
  Tasks.layer,
).pipe(
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(database),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "axis-workflow-service-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(
    Layer.mock(ServerEnvironmentIdentity)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(AxisProjectScope, {
      resolve: (input) => Effect.succeed(input),
      resolveProject: (input) => Effect.succeed(input),
    }),
  ),
);
const execution = Execution.layer.pipe(Layer.provideMerge(infrastructure));
const workflow = Workflow.layer.pipe(Layer.provideMerge(execution));
const layer = Store.layer.pipe(Layer.provideMerge(workflow));
type Requested = Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;

const setup = Effect.fn("workflowServiceTest.setup")(function* (
  holdInterrupt = false,
  rejectInterrupt = false,
) {
  const engine = yield* OrchestrationEngineService;
  const tasks = yield* Tasks.AxisTaskStore;
  const store = yield* Store.AxisTaskWorkflowStore;
  const service = yield* Service.make;
  const sql = yield* SqlClient.SqlClient;
  const requested = yield* Queue.unbounded<Requested>();
  const interrupted = yield* Queue.unbounded<ThreadId>();
  const allowInterrupt = yield* Deferred.make<void>();
  let sequence = 0;
  const id = () => CommandId.make(`fixture-${++sequence}`);
  const commands: Requested[] = [];
  const interrupts: ThreadId[] = [];
  const turn = (request: Workflow.WorkflowRequest) => TurnId.make(`turn-${request.commandId}`);
  const session = (
    request: Workflow.WorkflowRequest,
    status: "running" | "ready" | "error" | "interrupted",
  ) =>
    engine.dispatch({
      type: "thread.session.set",
      commandId: id(),
      threadId: Workflow.attemptThreadId(request),
      createdAt: now,
      session: {
        threadId: Workflow.attemptThreadId(request),
        status,
        providerName: "codex",
        providerInstanceId: request.modelSelection.instanceId,
        runtimeMode: "approval-required",
        activeTurnId: status === "running" ? turn(request) : null,
        lastError: status === "error" ? "Synthetic provider failure" : null,
        updatedAt: now,
      },
    });
  yield* engine.dispatch({
    type: "project.create",
    commandId: id(),
    projectId: taskFor("project").scope.project.projectId,
    title: "Workflow service fixture",
    workspaceRoot: process.cwd(),
    defaultModelSelection: modelSelection,
    createdAt: now,
  });
  const events = yield* engine.subscribeDomainEvents;
  yield* events.pipe(
    Stream.runForEach(
      Effect.fn(function* (event) {
        if (event.type === "thread.turn-start-requested") {
          const rows = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM axis_workflow_attempts WHERE command_id = ${event.commandId}`;
          assert.equal(rows[0]?.count, 1, "Admission must commit before provider dispatch.");
          commands.push(event);
          yield* Queue.offer(requested, event);
        }
        if (event.type === "thread.turn-interrupt-requested") {
          interrupts.push(event.payload.threadId);
          yield* Queue.offer(interrupted, event.payload.threadId);
          if (holdInterrupt) yield* Deferred.await(allowInterrupt);
          if (rejectInterrupt) {
            yield* engine.dispatch({
              type: "thread.activity.append",
              commandId: id(),
              threadId: event.payload.threadId,
              createdAt: now,
              activity: {
                id: EventId.make(`activity-${++sequence}`),
                kind: "provider.turn.interrupt.failed",
                tone: "error",
                summary: "Synthetic interrupt rejection",
                payload: {},
                turnId: null,
                createdAt: now,
              },
            });
          } else {
            yield* engine.dispatch({
              type: "thread.session.set",
              commandId: id(),
              threadId: event.payload.threadId,
              createdAt: now,
              session: {
                threadId: event.payload.threadId,
                status: "interrupted",
                providerName: "codex",
                providerInstanceId: modelSelection.instanceId,
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: null,
                updatedAt: now,
              },
            });
          }
        }
      }),
    ),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() => Deferred.succeed(allowInterrupt, undefined));
  const create = Effect.fn("workflowServiceTest.create")(function* (name: string) {
    const initial = taskFor(name);
    yield* engine.dispatch({
      type: "thread.create",
      commandId: id(),
      threadId: initial.threadId,
      projectId: initial.scope.project.projectId,
      title: initial.title,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: now,
    });
    const task = yield* tasks.create(initial, id());
    const input: Store.WorkflowAdmission = {
      scope: task.scope,
      taskId: task.id,
      threadId: task.threadId,
      stepId: task.steps[0]!.id,
      commandId: CommandId.make(`run-${name}`),
      expectedRevision: task.revision,
      modelSelection,
    };
    return { task, input };
  });
  const admitted = (input: Store.WorkflowAdmission) =>
    store.get(input.scope, input.threadId, input.commandId).pipe(Effect.map(Option.getOrThrow));
  const message = Effect.fn("workflowServiceTest.message")(function* (
    request: Workflow.WorkflowRequest,
    envelope = true,
  ) {
    const threadId = Workflow.attemptThreadId(request);
    const messageId = MessageId.make(`result-${request.commandId}`);
    yield* engine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: id(),
      threadId,
      messageId,
      turnId: turn(request),
      delta: envelope
        ? encode({ text: "Canonical analysis artifact." })
        : "Tests passed (unverified prose)",
      createdAt: now,
    });
    yield* engine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: id(),
      threadId,
      messageId,
      turnId: turn(request),
      createdAt: now,
    });
    return messageId;
  });
  const finish = Effect.fn("workflowServiceTest.finish")(function* (
    input: Store.WorkflowAdmission,
  ) {
    const request = yield* admitted(input);
    yield* session(request, "running");
    const messageId = yield* message(request);
    yield* session(request, "ready");
    return messageId;
  });
  const activity = (request: Workflow.WorkflowRequest, kind: string) =>
    engine.dispatch({
      type: "thread.activity.append",
      commandId: id(),
      threadId: Workflow.attemptThreadId(request),
      createdAt: now,
      activity: {
        id: EventId.make(`activity-${++sequence}`),
        kind,
        tone: "info",
        summary: kind,
        payload: { requestId: "approval", requestKind: "command", questions: [] },
        turnId: turn(request),
        createdAt: now,
      },
    });
  return {
    service,
    tasks,
    store,
    sql,
    create,
    admitted,
    session,
    message,
    finish,
    activity,
    requested,
    interrupted,
    allowInterrupt,
    commands,
    interrupts,
    turn,
  };
});

it.effect(
  "persists before dispatch, survives the request scope, and duplicate starts launch exactly once",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup();
        const { input } = yield* s.create("once");
        // Unknown client fields are discarded. The provider prompt uses the stored task.
        const payload = { ...input, task: { title: "CLIENT TASK INJECTION" } };
        yield* Effect.scoped(s.service.start(typedCaller, payload));
        yield* s.service.start(typedCaller, input);
        const event = yield* Queue.take(s.requested);
        assert.equal(event.commandId, input.commandId);
        const detail = Option.getOrThrow(
          yield* (yield* ProjectionSnapshotQuery).getThreadDetailById(event.payload.threadId, {
            activityKinds: [],
          }),
        );
        const prompt =
          detail.messages.find((message) => message.id === event.payload.messageId)?.text ?? "";
        assert.notInclude(prompt, "CLIENT TASK INJECTION");
        assert.include(prompt, "Analyze empty parser input");
        const running = yield* s.service.get(typedCaller, input);
        assert.equal(running.state.status, "accepted");
        assert.notEqual(running.state.execution.threadId, input.threadId);
        assert.equal(running.task.steps[0]?.status, "not-executed");
        assert.equal(
          (yield* Effect.flip(
            s.service.start(typedCaller, {
              ...input,
              modelSelection: { ...modelSelection, model: "different" },
            }),
          ))._tag,
          "AxisTaskCommandConflictError",
        );
        const messageId = yield* s.finish(input);
        const done = yield* s.service.get(typedCaller, input);
        assert.equal(done.state.status, "completed");
        assert.equal(done.state.artifact?.messageId, messageId);
        assert.equal(done.task.steps[0]?.status, "completed");
        assert.equal(done.task.steps[0]?.turnId, done.state.execution.turnId);
        const reloaded = yield* Service.make;
        assert.deepEqual(yield* reloaded.get(typedCaller, input), done);
        yield* reloaded.start(typedCaller, input);
        assert.equal(s.commands.length, 1);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect(
  "unsupported and oversized preflight leave no admission and can be corrected with the same command",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup();
        const { task, input } = yield* s.create("preflight");
        const unsupported = yield* s.tasks.update({
          task: {
            ...task,
            revision: task.revision + 1,
            steps: [{ ...task.steps[0]!, skillId: AxisSkillId.make("implement") }],
          },
          expectedRevision: task.revision,
          commandId: CommandId.make("unsupported-definition"),
        });
        let attempt = { ...input, expectedRevision: unsupported.revision };
        const blocked = yield* s.service.start(typedCaller, attempt);
        assert.equal(blocked.state.status, "blocked");
        assert.include(blocked.state.reason!, "persisted plan");
        assert.deepEqual(blocked.task, unsupported);
        assert.equal(
          Option.isNone(yield* s.store.get(input.scope, input.threadId, input.commandId)),
          true,
        );
        const restarted = yield* Service.make;
        assert.equal((yield* restarted.start(typedCaller, attempt)).state.status, "blocked");
        const oversized = yield* s.tasks.update({
          task: {
            ...unsupported,
            revision: unsupported.revision + 1,
            steps: task.steps,
            acceptanceCriteria: Array.from({ length: 40 }, (_, index) => ({
              id: AxisTaskStepId.make(`criterion-${index}`),
              text: "x".repeat(2_000),
            })),
          },
          expectedRevision: unsupported.revision,
          commandId: CommandId.make("oversized-definition"),
        });
        attempt = { ...input, expectedRevision: oversized.revision };
        const tooLarge = yield* restarted.start(typedCaller, attempt);
        assert.equal(tooLarge.state.status, "blocked");
        assert.include(tooLarge.state.reason!, "bounded execution prompt");
        assert.equal(
          Option.isNone(yield* s.store.get(input.scope, input.threadId, input.commandId)),
          true,
        );
        assert.equal(s.commands.length, 0);
        const corrected = yield* s.tasks.update({
          task: {
            ...oversized,
            revision: oversized.revision + 1,
            acceptanceCriteria: task.acceptanceCriteria,
          },
          expectedRevision: oversized.revision,
          commandId: CommandId.make("corrected-definition"),
        });
        yield* restarted.start(typedCaller, { ...input, expectedRevision: corrected.revision });
        yield* Queue.take(s.requested);
        yield* s.finish(input);
        assert.equal((yield* restarted.get(typedCaller, input)).state.status, "completed");
        assert.equal(s.commands.length, 1);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect(
  "analysis to impact to plan uses immutable prior requests across model and task revisions",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup();
        const { task, input } = yield* s.create("sequence");
        const configured = yield* s.tasks.update({
          task: {
            ...task,
            revision: task.revision + 1,
            steps: [
              task.steps[0]!,
              {
                ...task.steps[0]!,
                id: AxisTaskStepId.make("impact"),
                skillId: AxisSkillId.make("impact"),
              },
              {
                ...task.steps[0]!,
                id: AxisTaskStepId.make("plan"),
                skillId: AxisSkillId.make("plan"),
              },
            ],
          },
          expectedRevision: task.revision,
          commandId: CommandId.make("configure-sequence"),
        });
        const prematurePlan = {
          ...input,
          stepId: configured.steps[2]!.id,
          commandId: CommandId.make("sequence-plan"),
          expectedRevision: configured.revision,
        };
        const blocked = yield* s.service.start(typedCaller, prematurePlan);
        assert.equal(blocked.state.status, "blocked");
        assert.equal(blocked.task.steps[2]?.commandId, null);
        assert.equal(
          Option.isNone(yield* s.store.get(input.scope, input.threadId, prematurePlan.commandId)),
          true,
        );
        yield* s.service.start(typedCaller, { ...input, expectedRevision: configured.revision });
        yield* Queue.take(s.requested);
        const analysisMessage = yield* s.finish(input);
        const analysis = yield* s.service.get(typedCaller, input);
        const edited = yield* s.tasks.update({
          task: {
            ...analysis.task,
            title: "Refined parser objective",
            revision: analysis.task.revision + 1,
          },
          expectedRevision: analysis.task.revision,
          commandId: CommandId.make("refine-objective"),
        });
        const impactInput = {
          ...input,
          stepId: configured.steps[1]!.id,
          commandId: CommandId.make("sequence-impact"),
          expectedRevision: edited.revision,
          modelSelection: { ...modelSelection, model: "impact-model" },
        };
        const restarted = yield* Service.make;
        yield* restarted.start(typedCaller, impactInput);
        const impactEvent = yield* Queue.take(s.requested);
        const projections = yield* ProjectionSnapshotQuery;
        const impactDetail = Option.getOrThrow(
          yield* projections.getThreadDetailById(impactEvent.payload.threadId, {
            activityKinds: [],
          }),
        );
        const impactPrompt = impactDetail.messages.find(
          (message) => message.id === impactEvent.payload.messageId,
        )!.text;
        assert.include(impactPrompt, analysisMessage);
        assert.include(impactPrompt, analysis.state.artifact!.requestDigest);
        assert.include(impactPrompt, "Refined parser objective");
        const impactMessage = yield* s.finish(impactInput);
        const impact = yield* restarted.get(typedCaller, impactInput);
        assert.equal(impact.state.status, "completed");
        const planInput = {
          ...prematurePlan,
          expectedRevision: impact.task.revision,
          modelSelection: { ...modelSelection, model: "plan-model" },
        };
        yield* restarted.start(typedCaller, planInput);
        const planEvent = yield* Queue.take(s.requested);
        const planDetail = Option.getOrThrow(
          yield* projections.getThreadDetailById(planEvent.payload.threadId, { activityKinds: [] }),
        );
        const planPrompt = planDetail.messages.find(
          (message) => message.id === planEvent.payload.messageId,
        )!.text;
        assert.include(planPrompt, analysisMessage);
        assert.include(planPrompt, impactMessage);
        yield* s.finish(planInput);
        const final = yield* restarted.get(typedCaller, planInput);
        assert.equal(final.state.status, "completed");
        assert.equal(
          final.task.steps.every((step) => step.status === "completed"),
          true,
        );
        yield* restarted.start(typedCaller, planInput);
        assert.equal(s.commands.length, 3);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("missing immutable prerequisite and blocked retry never consume a new command", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup();
      const { task, input } = yield* s.create("missing-prior");
      const configured = yield* s.tasks.update({
        task: {
          ...task,
          revision: task.revision + 1,
          steps: [
            { ...task.steps[0]!, commandId: CommandId.make("not-stored"), status: "completed" },
            {
              ...task.steps[0]!,
              id: AxisTaskStepId.make("plan"),
              skillId: AxisSkillId.make("plan"),
            },
          ],
        },
        expectedRevision: task.revision,
        commandId: CommandId.make("fake-prior"),
      });
      const plan = {
        ...input,
        expectedRevision: configured.revision,
        stepId: configured.steps[1]!.id,
      };
      const blocked = yield* s.service.start(typedCaller, plan);
      assert.equal(blocked.state.status, "blocked");
      assert.include(blocked.state.reason!, "immutable request");
      assert.equal(
        Option.isNone(yield* s.store.get(input.scope, input.threadId, input.commandId)),
        true,
      );
      const other = yield* s.create("retry-preflight");
      yield* s.service.start(typedCaller, other.input);
      yield* Queue.take(s.requested);
      const old = yield* s.admitted(other.input);
      yield* s.session(old, "running");
      yield* s.session(old, "error");
      const failed = yield* s.service.get(typedCaller, other.input);
      const changed = yield* s.tasks.update({
        task: {
          ...failed.task,
          revision: failed.task.revision + 1,
          steps: [{ ...failed.task.steps[0]!, skillId: AxisSkillId.make("verify") }],
        },
        expectedRevision: failed.task.revision,
        commandId: CommandId.make("unsupported-retry"),
      });
      const retry = {
        ...other.input,
        commandId: CommandId.make("blocked-retry"),
        previousCommandId: other.input.commandId,
        expectedRevision: changed.revision,
      };
      const retryBlocked = yield* s.service.retry(typedCaller, retry);
      assert.equal(retryBlocked.state.status, "blocked");
      assert.deepEqual(retryBlocked.task, changed);
      assert.equal(
        Option.isNone(yield* s.store.get(retry.scope, retry.threadId, retry.commandId)),
        true,
      );
      assert.equal(s.commands.length, 1);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("concurrent starts share the durable admission across service instances", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup();
      const { input } = yield* s.create("concurrent");
      const other = yield* Service.make;
      yield* Effect.all([s.service.start(typedCaller, input), other.start(typedCaller, input)], {
        concurrency: "unbounded",
      });
      yield* Queue.take(s.requested);
      yield* s.finish(input);
      assert.equal((yield* other.get(typedCaller, input)).state.status, "completed");
      assert.equal(s.commands.length, 1);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect(
  "a crash after admission never silently replays or permits retry without canonical failure",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup();
        const { input } = yield* s.create("orphan");
        yield* s.store.admit(input);
        const restarted = yield* Service.make;
        const orphan = yield* restarted.start(typedCaller, input);
        assert.equal(orphan.state.status, "unknown");
        assert.equal(
          (yield* Effect.flip(
            restarted.retry(typedCaller, {
              ...input,
              expectedRevision: orphan.task.revision,
              previousCommandId: input.commandId,
              commandId: CommandId.make("orphan-retry"),
            }),
          ))._tag,
          "AxisTaskWorkflowServiceError",
        );
        assert.equal(s.commands.length, 0);
        const rows = yield* s.sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM axis_workflow_attempts`;
        assert.equal(rows[0]?.count, 1);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect(
  "reads immutable requests after task edits and never marks the changed definition completed",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup();
        const { input } = yield* s.create("edited");
        const initial = yield* s.service.start(typedCaller, input);
        yield* Queue.take(s.requested);
        yield* s.tasks.update({
          task: {
            ...initial.task,
            title: "A different task definition",
            revision: initial.task.revision + 1,
          },
          expectedRevision: initial.task.revision,
          commandId: CommandId.make("edit-definition"),
        });
        yield* s.finish(input);
        const restarted = yield* Service.make;
        const result = yield* restarted.get(typedCaller, input);
        assert.equal(
          result.state.status,
          "completed",
          "The old attempt is read using its immutable definition.",
        );
        assert.equal(result.task.title, "A different task definition");
        assert.equal(
          result.task.steps[0]?.status,
          "not-executed",
          "Old evidence must not complete the changed task.",
        );
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect(
  "cancel waits for real provider confirmation; retry gets a new thread and late cancel cannot hit it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup(true);
        const { input } = yield* s.create("cancel");
        const started = yield* s.service.start(typedCaller, input);
        yield* Queue.take(s.requested);
        const old = yield* s.admitted(input);
        yield* s.session(old, "running");
        const cancellation = yield* s.service
          .cancel(typedCaller, { ...input, expectedRevision: started.task.revision })
          .pipe(Effect.forkScoped);
        assert.equal(yield* Queue.take(s.interrupted), Workflow.attemptThreadId(old));
        assert.equal(cancellation.pollUnsafe(), undefined);
        const premature = yield* Effect.flip(
          s.service.retry(typedCaller, {
            ...input,
            expectedRevision: started.task.revision,
            previousCommandId: input.commandId,
            commandId: CommandId.make("premature"),
          }),
        );
        assert.equal(premature._tag, "AxisTaskWorkflowServiceError");
        yield* Deferred.succeed(s.allowInterrupt, undefined);
        const cancelled = yield* Fiber.join(cancellation);
        assert.equal(cancelled.state.status, "interrupted");
        assert.equal(cancelled.task.steps[0]?.status, "failed");
        const retry = {
          ...input,
          expectedRevision: cancelled.task.revision,
          previousCommandId: input.commandId,
          commandId: CommandId.make("retry-cancel"),
          modelSelection: { ...modelSelection, model: "second-model" },
        };
        yield* s.service.retry(typedCaller, retry);
        const next = yield* Queue.take(s.requested);
        assert.notEqual(next.payload.threadId, Workflow.attemptThreadId(old));
        yield* s.service.retry(typedCaller, retry);
        yield* s.service.cancel(typedCaller, { ...input, expectedRevision: started.task.revision });
        yield* s.finish(retry);
        assert.equal((yield* s.service.get(typedCaller, retry)).state.status, "completed");
        assert.equal(s.commands.length, 2);
        assert.deepEqual(s.interrupts, [Workflow.attemptThreadId(old)]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("cancels and permits retry when interruption is confirmed before turn start", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup();
      const { input } = yield* s.create("cancel-before-turn");
      const started = yield* s.service.start(typedCaller, input);
      yield* Queue.take(s.requested);
      const cancelled = yield* s.service.cancel(typedCaller, {
        ...input,
        expectedRevision: started.task.revision,
      });
      assert.equal(cancelled.state.status, "interrupted");
      assert.equal(cancelled.state.execution.turnId, null);
      const retry = {
        ...input,
        expectedRevision: cancelled.task.revision,
        previousCommandId: input.commandId,
        commandId: CommandId.make("retry-after-pre-turn-cancel"),
      };
      yield* s.service.retry(typedCaller, retry);
      const next = yield* Queue.take(s.requested);
      assert.equal(next.commandId, retry.commandId);
      assert.notEqual(next.payload.threadId, Workflow.attemptThreadId(yield* s.admitted(input)));
      yield* s.finish(retry);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect(
  "another service instance cancels through a durable orchestration interrupt receipt",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup();
        const { input } = yield* s.create("remote-cancel");
        const started = yield* s.service.start(typedCaller, input);
        yield* Queue.take(s.requested);
        yield* s.session(yield* s.admitted(input), "running");
        const other = yield* Service.make;
        const cancelled = yield* other.cancel(typedCaller, {
          ...input,
          expectedRevision: started.task.revision,
        });
        assert.equal(cancelled.state.status, "interrupted");
        yield* other.cancel(typedCaller, { ...input, expectedRevision: started.task.revision });
        assert.equal(s.interrupts.length, 1);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect(
  "failed interruption is explicit and does not permit retry of a still-running provider",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup(false, true);
        const { input } = yield* s.create("cancel-failed");
        const started = yield* s.service.start(typedCaller, input);
        yield* Queue.take(s.requested);
        const request = yield* s.admitted(input);
        yield* s.session(request, "running");
        const result = yield* Effect.flip(
          s.service.cancel(typedCaller, { ...input, expectedRevision: started.task.revision }),
        );
        assert.equal(result._tag, "AxisTaskWorkflowServiceError");
        if (result._tag === "AxisTaskWorkflowServiceError")
          assert.equal(result.reason, "cancel_unconfirmed");
        const current = yield* s.service.get(typedCaller, input);
        assert.equal(current.state.status, "unknown");
        assert.equal(
          (yield* Effect.flip(
            s.service.retry(typedCaller, {
              ...input,
              expectedRevision: current.task.revision,
              commandId: CommandId.make("unsafe-retry"),
              previousCommandId: input.commandId,
            }),
          ))._tag,
          "AxisTaskWorkflowServiceError",
        );
        yield* s.session(request, "interrupted");
      }),
    ).pipe(Effect.provide(layer)),
);

for (const kind of ["approval", "user-input"])
  it.effect(`distinguishes ${kind} waiting from failure and preserves pending metadata`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup();
        const { input } = yield* s.create(kind);
        yield* s.service.start(typedCaller, input);
        yield* Queue.take(s.requested);
        const request = yield* s.admitted(input);
        yield* s.session(request, "running");
        yield* s.activity(request, `${kind}.requested`);
        const waiting = yield* s.service.get(typedCaller, input);
        assert.equal(waiting.state.status, "waiting-input");
        assert.equal(waiting.task.steps[0]?.status, "not-executed");
        yield* s.activity(request, `${kind}.resolved`);
        yield* s.session(request, "error");
        const failed = yield* s.service.get(typedCaller, input);
        assert.equal(failed.state.status, "failed");
        assert.equal(failed.task.steps[0]?.status, "failed");
      }),
    ).pipe(Effect.provide(layer)),
  );

it.effect("a completed turn without canonical artifact cannot complete task metadata", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup();
      const { input } = yield* s.create("no-artifact");
      yield* s.service.start(typedCaller, input);
      yield* Queue.take(s.requested);
      const request = yield* s.admitted(input);
      yield* s.session(request, "running");
      yield* s.message(request, false);
      yield* s.session(request, "ready");
      const result = yield* s.service.get(typedCaller, input);
      assert.equal(result.state.status, "validation-pending");
      assert.equal(result.state.artifact, null);
      assert.equal(result.task.steps[0]?.status, "not-executed");
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("independent threads make progress while one cancellation waits for its provider", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup(true);
      const first = (yield* s.create("first")).input;
      const second = (yield* s.create("second")).input;
      const started = yield* s.service.start(typedCaller, first);
      yield* Queue.take(s.requested);
      yield* s.session(yield* s.admitted(first), "running");
      const stopping = yield* s.service
        .cancel(typedCaller, { ...first, expectedRevision: started.task.revision })
        .pipe(Effect.forkScoped);
      yield* Queue.take(s.interrupted);
      yield* s.service.start(typedCaller, second);
      // The fixture's interrupt handler is held; use the canonical dispatch receipt
      // for progress rather than waiting for that intentionally held consumer.
      const events = yield* (yield* OrchestrationEngineService).subscribeDomainEvents;
      const secondStarted = yield* events.pipe(
        Stream.filter(
          (event) =>
            event.type === "thread.turn-start-requested" && event.commandId === second.commandId,
        ),
        Stream.runHead,
        Effect.forkScoped,
      );
      const stored = yield* s.admitted(second);
      const state = yield* (yield* Workflow.AxisTaskWorkflow).getState(stored);
      if (state.status === "not-executed" || state.status === "unknown")
        yield* Fiber.join(secondStarted);
      yield* s.finish(second);
      assert.equal((yield* s.service.get(typedCaller, second)).state.status, "completed");
      assert.equal(stopping.pollUnsafe(), undefined);
      yield* Deferred.succeed(s.allowInterrupt, undefined);
      yield* Fiber.join(stopping);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect(
  "validates provider scope before admission and fails closed on unreadable canonical state",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup();
        const { input } = yield* s.create("denied");
        const denied = yield* Service.make.pipe(
          Effect.provideService(AxisProjectScope, {
            resolveProject: (input) => Effect.succeed(input),
            resolve: () =>
              Effect.fail(
                new AxisProjectScopeResolutionError({
                  reason: "provider_not_accessible",
                  message: "Denied",
                }),
              ),
          }),
        );
        const failure = yield* Effect.flip(denied.start(typedCaller, input));
        assert.equal(failure._tag, "AxisTaskWorkflowServiceError");
        assert.equal(
          Option.isNone(yield* s.store.get(input.scope, input.threadId, input.commandId)),
          true,
        );
        yield* s.store.admit(input);
        const real = yield* Workflow.AxisTaskWorkflow;
        const unreadable = yield* Service.make.pipe(
          Effect.provideService(Workflow.AxisTaskWorkflow, {
            ...real,
            getState: () =>
              Effect.fail(
                new Workflow.AxisTaskWorkflowError({
                  reason: "observation_failed",
                  message: "Unreadable canonical rows",
                }),
              ),
          }),
        );
        const readError = yield* Effect.flip(unreadable.get(typedCaller, input));
        assert.equal(readError._tag, "AxisTaskWorkflowServiceError");
        if (readError._tag === "AxisTaskWorkflowServiceError")
          assert.equal(readError.reason, "observation_failed");
        assert.equal(s.commands.length, 0);
      }),
    ).pipe(Effect.provide(layer)),
);

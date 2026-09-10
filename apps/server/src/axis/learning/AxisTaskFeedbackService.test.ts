import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AxisContextCatalog,
  AxisTaskExtension,
  AxisTaskId,
  AxisTaskStepId,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import {
  ServerEnvironment,
  ServerEnvironmentIdentity,
} from "../../environment/ServerEnvironment.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { AxisContextCatalogStore } from "../contexts/AxisContextCatalogStore.ts";
import * as ProjectScope from "../projects/AxisProjectScope.ts";
import * as Tasks from "../tasks/AxisTaskStore.ts";
import * as Execution from "../tasks/AxisTaskExecution.ts";
import * as Workflow from "../tasks/AxisTaskWorkflow.ts";
import * as Attempts from "../tasks/AxisTaskWorkflowStore.ts";
import * as Learning from "./AxisLearningStore.ts";
import * as Feedback from "./AxisTaskFeedbackService.ts";
import { AxisTaskFeedbackRequest } from "../../../../../packages/contracts/src/axisTaskFeedback.ts";

const now = "2026-09-10T12:00:00.000Z";
const decodeTask = Schema.decodeUnknownSync(AxisTaskExtension);
const decodeRequest = Schema.decodeUnknownSync(AxisTaskFeedbackRequest);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const modelSelection = { instanceId: ProviderInstanceId.make("synthetic"), model: "fixture-model" };
const taskFor = (name: string, projectId = "project-a") =>
  decodeTask({
    id: name,
    scope: { contextId: "company", project: { environmentId: "env", projectId } },
    threadId: `task-${name}`,
    title: "Analyze the parser",
    acceptanceCriteria: [{ id: "criterion", text: "Explain empty input." }],
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
const caller = {
  contextId: taskFor("caller").scope.contextId,
  environmentId: EnvironmentId.make("env"),
};
const catalog = Schema.decodeUnknownSync(AxisContextCatalog)({
  contexts: [
    { id: "company", kind: "company", name: "Synthetic company", createdAt: now, updatedAt: now },
  ],
  projectBindings: ["project-a", "project-b"].map((projectId) => ({
    contextId: "company",
    project: { environmentId: "env", projectId },
  })),
  providerOwnerships: [
    { contextId: "company", provider: { environmentId: "env", instanceId: "synthetic" } },
  ],
  providerAccessGrants: [],
  capabilities: [],
  workHubSources: [],
});
const environment = Layer.mergeAll(
  Layer.mock(ServerEnvironmentIdentity)({
    getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
  }),
  Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(EnvironmentId.make("env")) }),
  Layer.mock(AxisContextCatalogStore)({
    get: Effect.succeed({ revision: 1, catalog, updatedAt: now }),
  }),
);
const infrastructure = Layer.mergeAll(
  OrchestrationEngineLive.pipe(Layer.provide(OrchestrationProjectionPipelineLive)),
  Tasks.layer,
  Learning.layer,
  ProjectionTurnRepositoryLive,
  ProjectScope.layer,
).pipe(
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(environment),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "axis-feedback-" })),
  Layer.provideMerge(NodeServices.layer),
);
const execution = Execution.layer.pipe(Layer.provideMerge(infrastructure));
const workflow = Workflow.layer.pipe(Layer.provideMerge(execution));
const layer = Attempts.layer.pipe(Layer.provideMerge(workflow));
type Requested = Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;

const setup = Effect.fn("feedbackTest.setup")(function* () {
  const engine = yield* OrchestrationEngineService;
  const tasks = yield* Tasks.AxisTaskStore;
  const attempts = yield* Attempts.AxisTaskWorkflowStore;
  const workflow = yield* Workflow.AxisTaskWorkflow;
  const service = yield* Feedback.make;
  const learning = yield* Learning.AxisLearningStore;
  const requested = yield* Queue.unbounded<Requested>();
  let sequence = 0;
  const id = () => CommandId.make(`fixture-${++sequence}`);
  const turnId = (request: Workflow.WorkflowRequest) => TurnId.make(`turn-${request.commandId}`);
  for (const projectId of ["project-a", "project-b"])
    yield* engine.dispatch({
      type: "project.create",
      commandId: id(),
      projectId: ProjectId.make(projectId),
      title: "Feedback fixture",
      workspaceRoot: `${process.cwd()}/apps/${projectId === "project-a" ? "server" : "web"}`,
      defaultModelSelection: modelSelection,
      createdAt: now,
    });
  const events = yield* engine.subscribeDomainEvents;
  yield* events.pipe(
    Stream.runForEach((event) =>
      event.type === "thread.turn-start-requested"
        ? Queue.offer(requested, event).pipe(Effect.asVoid)
        : Effect.void,
    ),
    Effect.forkScoped,
  );
  const create = Effect.fn("feedbackTest.create")(function* (
    name: string,
    projectId = "project-a",
  ) {
    const initial = taskFor(name, projectId);
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
    const admission = {
      scope: task.scope,
      taskId: task.id,
      threadId: task.threadId,
      stepId: task.steps[0]!.id,
      commandId: CommandId.make(`run-${name}`),
      expectedRevision: task.revision,
      modelSelection,
    };
    const { request } = yield* attempts.admit(admission);
    const lookup = decodeRequest({
      scope: task.scope,
      taskId: task.id,
      threadId: task.threadId,
      stepId: request.stepId,
      commandId: request.commandId,
    });
    return { request, lookup };
  });
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
        providerName: "codex",
        providerInstanceId: modelSelection.instanceId,
        status,
        activeTurnId: status === "running" ? turnId(request) : null,
        runtimeMode: "approval-required",
        lastError: status === "error" ? "Synthetic provider failure" : null,
        updatedAt: now,
      },
    });
  const start = Effect.fn("feedbackTest.start")(function* (request: Workflow.WorkflowRequest) {
    const fiber = yield* workflow.dispatch(request).pipe(Effect.exit, Effect.forkScoped);
    const event = yield* Queue.take(requested);
    assert.equal(event.commandId, request.commandId);
    yield* session(request, "running");
    return fiber;
  });
  const complete = Effect.fn("feedbackTest.complete")(function* (
    request: Workflow.WorkflowRequest,
  ) {
    const threadId = Workflow.attemptThreadId(request);
    const messageId = MessageId.make(`result-${request.commandId}`);
    yield* engine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: id(),
      threadId,
      messageId,
      turnId: turnId(request),
      delta: encode({ text: "Parser analysis document. This is not proof that tests ran." }),
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
    yield* session(request, "ready");
  });
  return {
    engine,
    tasks,
    attempts,
    workflow,
    service,
    learning,
    create,
    start,
    complete,
    session,
    turnId,
    id,
  };
});

it.effect(
  "records a canonical completion through the approved leaf and deduplicates concurrent/restarted replay",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup();
        const { request, lookup } = yield* s.create("complete");
        const fiber = yield* s.start(request);
        yield* s.complete(request);
        yield* Fiber.join(fiber);
        const [first, concurrent] = yield* Effect.all(
          [s.service.record(caller, lookup), s.service.record(caller, lookup)],
          { concurrency: "unbounded" },
        );
        assert.deepEqual(first, concurrent);
        assert.equal(first.summary, "Task execution completed.");
        assert.equal(
          first.provenance.sourceId,
          `axis-task:${request.task.id}:thread:${Workflow.attemptThreadId(request)}:turn:${s.turnId(request)}:outcome:completed`,
        );
        assert.equal(first.provenance.observedAt, now);
        assert.deepEqual(first.provenance.scope, request.task.scope);
        assert.deepEqual(first.provenance.provider, {
          environmentId: request.task.scope.project.environmentId,
          instanceId: request.modelSelection.instanceId,
        });
        const restarted = yield* Feedback.make;
        assert.deepEqual(
          yield* restarted.record(caller, { ...lookup, expectedTurnId: s.turnId(request) }),
          first,
        );
        assert.equal((yield* s.learning.listEvidence(caller.contextId, lookup.scope)).length, 1);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect(
  "derives failure from the concrete failed turn, never from submitted outcome/summary",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup();
        const { request, lookup } = yield* s.create("failed");
        const fiber = yield* s.start(request);
        const forged = {
          ...lookup,
          outcome: "completed",
          summary: "All checks passed",
          observedAt: now,
        };
        assert.equal(
          (yield* Effect.flip(s.service.record(caller, forged))).reason,
          "invalid_input",
        );
        assert.equal((yield* Effect.flip(s.service.record(caller, lookup))).reason, "not_terminal");
        yield* s.session(request, "error");
        yield* Fiber.join(fiber);
        const result = yield* s.service.record(caller, lookup);
        assert.equal(result.summary, "Task execution failed.");
        assert.include(result.provenance.sourceId, `turn:${s.turnId(request)}:outcome:failed`);
        assert.equal((yield* s.learning.listEvidence(caller.contextId, lookup.scope)).length, 1);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("rejects mismatched caller, scope, task, step and turn without writing evidence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup();
      const { request, lookup } = yield* s.create("mismatch");
      const fiber = yield* s.start(request);
      yield* s.complete(request);
      yield* Fiber.join(fiber);
      assert.equal(
        (yield* Effect.flip(
          s.service.record({ ...caller, environmentId: EnvironmentId.make("another") }, lookup),
        )).reason,
        "scope_denied",
      );
      const otherScope = {
        ...lookup.scope,
        project: { ...lookup.scope.project, projectId: ProjectId.make("project-b") },
      };
      assert.equal(
        (yield* Effect.flip(s.service.record(caller, { ...lookup, scope: otherScope }))).reason,
        "not_found",
      );
      assert.equal(
        (yield* Effect.flip(
          s.service.record(caller, { ...lookup, taskId: AxisTaskId.make("another-task") }),
        )).reason,
        "mismatch",
      );
      assert.equal(
        (yield* Effect.flip(
          s.service.record(caller, { ...lookup, stepId: AxisTaskStepId.make("another-step") }),
        )).reason,
        "mismatch",
      );
      assert.equal(
        (yield* Effect.flip(
          s.service.record(caller, { ...lookup, expectedTurnId: TurnId.make("another-turn") }),
        )).reason,
        "mismatch",
      );
      assert.equal((yield* s.learning.listEvidence(caller.contextId, lookup.scope)).length, 0);
      assert.equal((yield* s.learning.listEvidence(caller.contextId, otherScope)).length, 0);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect(
  "isolates real execution evidence across projects and rejects revoked bindings even on replay",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup();
        const first = yield* s.create("project-one");
        const second = yield* s.create("project-two", "project-b");
        for (const { request, lookup } of [first, second]) {
          const fiber = yield* s.start(request);
          yield* s.complete(request);
          yield* Fiber.join(fiber);
          yield* s.service.record(caller, lookup);
        }
        const firstRows = yield* s.learning.listEvidence(caller.contextId, first.lookup.scope);
        const secondRows = yield* s.learning.listEvidence(caller.contextId, second.lookup.scope);
        assert.equal(firstRows.length, 1);
        assert.equal(secondRows.length, 1);
        assert.notEqual(firstRows[0]?.id, secondRows[0]?.id);
        const revokedScope = yield* ProjectScope.make.pipe(
          Effect.provideService(AxisContextCatalogStore, {
            get: Effect.succeed({
              revision: 2,
              catalog: { ...catalog, projectBindings: [] },
              updatedAt: now,
            }),
            replace: () => Effect.die("unused"),
          }),
        );
        const revoked = yield* Feedback.make.pipe(
          Effect.provideService(ProjectScope.AxisProjectScope, revokedScope),
        );
        assert.equal(
          (yield* Effect.flip(revoked.record(caller, first.lookup))).reason,
          "scope_denied",
        );
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("mutable completed task flags and an orphan admission are not execution proof", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup();
      const { request, lookup } = yield* s.create("orphan");
      const current = Option.getOrThrow(yield* s.tasks.get(lookup.scope, lookup.threadId));
      yield* s.tasks.update({
        task: {
          ...current,
          revision: current.revision + 1,
          steps: [
            {
              ...current.steps[0]!,
              status: "completed",
              turnId: TurnId.make("fabricated"),
              finishedAt: now,
            },
          ],
        },
        expectedRevision: current.revision,
        commandId: s.id(),
      });
      assert.equal((yield* Effect.flip(s.service.record(caller, lookup))).reason, "not_terminal");
      assert.equal(
        (yield* s.learning.listEvidence(caller.contextId, request.task.scope)).length,
        0,
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect(
  "records an old failed attempt after a retry using its immutable request, independently of new task metadata",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup();
        const { request, lookup } = yield* s.create("retry");
        const fiber = yield* s.start(request);
        yield* s.session(request, "error");
        yield* Fiber.join(fiber);
        const first = yield* s.service.record(caller, lookup);
        const failed = yield* s.workflow.getState(request);
        yield* s.attempts.settle(request, failed);
        const current = Option.getOrThrow(yield* s.tasks.get(lookup.scope, lookup.threadId));
        yield* s.attempts.retry(
          {
            ...lookup,
            previousCommandId: request.commandId,
            commandId: CommandId.make("retry-command"),
            expectedRevision: current.revision,
            modelSelection: { ...modelSelection, model: "retry-model" },
          },
          failed,
        );
        assert.deepEqual(yield* s.service.record(caller, lookup), first);
        assert.equal(
          Option.getOrThrow(yield* s.tasks.get(lookup.scope, lookup.threadId)).steps[0]?.commandId,
          "retry-command",
        );
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect(
  "interrupt requests and confirmed cancellations are not reported as completed or failed",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup();
        const { request, lookup } = yield* s.create("interrupt");
        const fiber = yield* s.start(request);
        yield* s.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: s.id(),
          threadId: Workflow.attemptThreadId(request),
          turnId: s.turnId(request),
          createdAt: now,
        });
        assert.equal((yield* Effect.flip(s.service.record(caller, lookup))).reason, "not_terminal");
        yield* s.session(request, "interrupted");
        yield* Fiber.join(fiber);
        assert.equal((yield* Effect.flip(s.service.record(caller, lookup))).reason, "not_terminal");
        assert.equal((yield* s.learning.listEvidence(caller.contextId, lookup.scope)).length, 0);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect(
  "a changed canonical turn correlation invalidates feedback even if evidence was previously recorded",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup();
        const { request, lookup } = yield* s.create("turn-corruption");
        const fiber = yield* s.start(request);
        yield* s.complete(request);
        yield* Fiber.join(fiber);
        yield* s.service.record(caller, lookup);
        const turns = yield* ProjectionTurnRepository;
        const row = Option.getOrThrow(
          yield* turns.getByTurnId({
            threadId: Workflow.attemptThreadId(request),
            turnId: s.turnId(request),
          }),
        );
        yield* turns.upsertByTurnId({
          ...row,
          pendingMessageId: MessageId.make("another-command-message"),
        });
        assert.equal((yield* Effect.flip(s.service.record(caller, lookup))).reason, "not_terminal");
        assert.equal((yield* s.learning.listEvidence(caller.contextId, lookup.scope)).length, 1);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect(
  "a persisted receipt whose aggregate no longer matches is unknown and cannot produce feedback",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* setup();
        const { request, lookup } = yield* s.create("receipt");
        const fiber = yield* s.start(request);
        yield* s.complete(request);
        yield* Fiber.join(fiber);
        const receiptRepo = yield* OrchestrationCommandReceiptRepository;
        const receipt = Option.getOrThrow(
          yield* receiptRepo.getByCommandId({ commandId: request.commandId }),
        );
        yield* receiptRepo.upsert({
          ...receipt,
          aggregateId: request.task.threadId,
        });
        assert.equal((yield* Effect.flip(s.service.record(caller, lookup))).reason, "not_terminal");
        assert.equal((yield* s.learning.listEvidence(caller.contextId, lookup.scope)).length, 0);
      }),
    ).pipe(Effect.provide(layer)),
);

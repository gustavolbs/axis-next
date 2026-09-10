import {
  CommandId,
  AxisWorkflowLookup as WorkflowLookup,
  AxisWorkflowCancel as WorkflowCancel,
  AxisWorkflowSnapshot as WorkflowSnapshot,
  AxisTaskWorkflowServiceError,
  AxisTaskValidationError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { AxisProjectScope, AxisProjectScopeCaller } from "../projects/AxisProjectScope.ts";
import { AxisTaskStore } from "./AxisTaskStore.ts";
import { CANCELLATION_TIMEOUT_MS } from "./AxisTaskExecution.ts";
import {
  AxisTaskWorkflow,
  AxisTaskWorkflowError,
  WorkflowState,
  type WorkflowRequest,
  type WorkflowPreparation,
} from "./AxisTaskWorkflow.ts";
import {
  AxisTaskWorkflowStore,
  WorkflowAdmission,
  WorkflowRetryAdmission,
} from "./AxisTaskWorkflowStore.ts";

export { WorkflowLookup, WorkflowCancel, WorkflowSnapshot, AxisTaskWorkflowServiceError };
const error = (reason: AxisTaskWorkflowServiceError["reason"], message: string) =>
  new AxisTaskWorkflowServiceError({ reason, message });
const invalid = () => error("invalid_input", "Invalid workflow operation input.");
const observationFailed = () =>
  error("observation_failed", "Cannot read canonical workflow evidence.");
const decodeCaller = Schema.decodeUnknownEffect(AxisProjectScopeCaller);
const decodeLookup = Schema.decodeUnknownEffect(WorkflowLookup);
const decodeCancel = Schema.decodeUnknownEffect(WorkflowCancel);
const decodeStart = Schema.decodeUnknownEffect(WorkflowAdmission);
const decodeRetry = Schema.decodeUnknownEffect(WorkflowRetryAdmission);
const terminal = (state: WorkflowState) =>
  ["completed", "failed", "interrupted", "validation-pending"].includes(state.status);

/** Runtime connector, not a scheduler. Only a newly persisted admission launches
 * work in the service scope. After restart reads reconstruct canonical evidence;
 * an admission without evidence is unknown and can never implicitly replay.
 * RPC callers supply identity/revision only, and must pass server-derived caller
 * context here (plus enforce the transport's execute/write capabilities).
 */
export const make = Effect.gen(function* () {
  const runtimeScope = yield* Effect.scope;
  const store = yield* AxisTaskWorkflowStore;
  const tasks = yield* AxisTaskStore;
  const workflow = yield* AxisTaskWorkflow;
  const scopes = yield* AxisProjectScope;
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const active = new Map<CommandId, Fiber.Fiber<void>>();

  const authorize = Effect.fn("AxisTaskWorkflowService.authorize")(function* (
    rawCaller: AxisProjectScopeCaller,
    input: WorkflowLookup,
    operation: "read" | "write",
  ) {
    const caller = yield* decodeCaller(rawCaller).pipe(Effect.mapError(invalid));
    yield* scopes
      .resolveProject({ caller, scope: input.scope, operation })
      .pipe(Effect.mapError(() => error("scope_denied", "The caller cannot access this project.")));
    return caller;
  });
  const authorizeStart = Effect.fn("AxisTaskWorkflowService.authorizeStart")(function* (
    rawCaller: AxisProjectScopeCaller,
    input: WorkflowAdmission,
  ) {
    const caller = yield* authorize(rawCaller, input, "write");
    yield* scopes
      .resolve({
        caller,
        scope: input.scope,
        operation: "execute",
        provider: {
          environmentId: input.scope.project.environmentId,
          instanceId: input.modelSelection.instanceId,
        },
      })
      .pipe(
        Effect.mapError(() =>
          error("scope_denied", "The selected provider is not available to this project scope."),
        ),
      );
  });
  const load = Effect.fn("AxisTaskWorkflowService.load")(function* (input: WorkflowLookup) {
    const stored = yield* store.get(input.scope, input.threadId, input.commandId);
    if (
      Option.isNone(stored) ||
      stored.value.task.id !== input.taskId ||
      stored.value.stepId !== input.stepId
    )
      return yield* error("not_found", "No admitted attempt matches this scoped task and step.");
    return stored.value;
  });
  const currentTask = Effect.fn("AxisTaskWorkflowService.currentTask")(function* (
    request: WorkflowRequest,
  ) {
    const current = yield* tasks.get(request.task.scope, request.task.threadId);
    if (Option.isNone(current) || current.value.id !== request.task.id)
      return yield* error("not_found", "The admitted task no longer exists in this project.");
    return current.value;
  });
  const canonicalState = Effect.fn("AxisTaskWorkflowService.canonicalState")(function* (
    request: WorkflowRequest,
  ): Effect.fn.Return<WorkflowState, AxisTaskWorkflowServiceError> {
    const state = yield* workflow.getState(request).pipe(Effect.mapError(observationFailed));
    if (state.status !== "interrupted") return state;
    // The turn projector marks interrupted on the REQUEST event. Only the
    // provider session's terminal observation confirms that the effect stopped.
    const shell = yield* projections
      .getThreadShellById(state.execution.threadId)
      .pipe(Effect.mapError(observationFailed));
    const session = Option.isSome(shell) ? shell.value.session : null;
    if (session?.activeTurnId === null && session.status === "interrupted") return state;
    if (
      session?.activeTurnId === null &&
      (session.status === "error" || session.status === "stopped")
    )
      return {
        ...state,
        status: "failed",
        reason: "The provider session failed or stopped after interruption was requested.",
      };
    return {
      ...state,
      status: "unknown",
      reason:
        "Interruption was requested but the provider has not confirmed termination. Retry is blocked.",
    };
  });
  const observe = Effect.fn("AxisTaskWorkflowService.observe")(function* (
    request: WorkflowRequest,
  ): Effect.fn.Return<WorkflowState, AxisTaskWorkflowServiceError> {
    const state = yield* canonicalState(request);
    if (state.status !== "not-executed") return state;
    return {
      ...state,
      status: active.has(request.commandId) ? "accepted" : "unknown",
      reason: active.has(request.commandId)
        ? "Admission is durable; the service worker has not yet produced a canonical turn receipt."
        : "This durable admission has no canonical result. Its effect is unknown; automatic replay and retry are blocked.",
    };
  });
  const snapshot = Effect.fn("AxisTaskWorkflowService.snapshot")(function* (
    request: WorkflowRequest,
  ): Effect.fn.Return<
    WorkflowSnapshot,
    AxisTaskWorkflowServiceError | import("@t3tools/contracts").AxisTaskStoreError
  > {
    const state = yield* observe(request);
    // This is projection from evidence, not a fresh workflow action. It also
    // repairs metadata after a crash between the canonical result and settlement.
    if (terminal(state)) yield* store.settle(request, state);
    const task = yield* currentTask(request);
    return { task, state };
  });

  const launch = Effect.fn("AxisTaskWorkflowService.launch")(function* (
    request: WorkflowRequest,
    execute: NonNullable<WorkflowPreparation["execute"]>,
  ) {
    const ready = yield* Deferred.make<void>();
    const run = execute.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const observed = yield* canonicalState(request);
          const state =
            observed.status !== "not-executed"
              ? observed
              : Exit.isSuccess(exit)
                ? exit.value
                : {
                    ...observed,
                    status: "unknown" as const,
                    reason:
                      "Execution ended without a canonical result. Reconcile the admitted attempt; never replay it automatically.",
                  };
          yield* store.settle(request, state);
        }),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("Axis workflow worker ended with an error", Cause.squash(cause)),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          active.delete(request.commandId);
        }),
      ),
      Effect.asVoid,
    );
    const fiber = yield* Deferred.await(ready).pipe(
      Effect.andThen(run),
      Effect.interruptible,
      Effect.forkIn(runtimeScope),
    );
    active.set(request.commandId, fiber);
    yield* Deferred.succeed(ready, undefined);
  });

  const prepare = Effect.fn("AxisTaskWorkflowService.prepare")(function* (
    request: WorkflowRequest,
  ) {
    return yield* workflow
      .prepare(request, (commandId) =>
        store.get(request.task.scope, request.task.threadId, commandId).pipe(
          Effect.mapError(
            () =>
              new AxisTaskWorkflowError({
                reason: "observation_failed",
                message: "Cannot read the immutable prerequisite request.",
              }),
          ),
        ),
      )
      .pipe(Effect.mapError((cause) => new AxisTaskValidationError({ message: cause.message })));
  });

  const start = Effect.fn("AxisTaskWorkflowService.start")(function* (
    caller: AxisProjectScopeCaller,
    raw: WorkflowAdmission,
  ) {
    const input = yield* decodeStart(raw).pipe(Effect.mapError(invalid));
    yield* authorizeStart(caller, input);
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        let execution: WorkflowPreparation["execute"] = null;
        const admitted = yield* store.admit(input, (request) =>
          prepare(request).pipe(
            Effect.map((prepared) => {
              execution = prepared.execute;
              return prepared.execute === null ? prepared.state : null;
            }),
          ),
        );
        if (admitted.blocked !== undefined)
          return { task: yield* currentTask(admitted.request), state: admitted.blocked };
        if (admitted.created && execution !== null) yield* launch(admitted.request, execution);
        return yield* snapshot(admitted.request);
      }),
    );
  });
  const get = Effect.fn("AxisTaskWorkflowService.get")(function* (
    caller: AxisProjectScopeCaller,
    raw: WorkflowLookup,
  ) {
    const input = yield* decodeLookup(raw).pipe(Effect.mapError(invalid));
    yield* authorize(caller, input, "read");
    return yield* snapshot(yield* load(input));
  });
  const retry = Effect.fn("AxisTaskWorkflowService.retry")(function* (
    caller: AxisProjectScopeCaller,
    raw: WorkflowRetryAdmission,
  ) {
    const input = yield* decodeRetry(raw).pipe(Effect.mapError(invalid));
    yield* authorizeStart(caller, input);
    const previous = yield* load({ ...input, commandId: input.previousCommandId });
    // Reconstruct the OLD request, including its provider and definition. Never
    // reinterpret it using the retry's model or the mutable task metadata.
    const observed = yield* canonicalState(previous);
    if (observed.status !== "failed" && observed.status !== "interrupted")
      return yield* error(
        "conflict",
        "Retry requires observed failure or confirmed interruption of the previous attempt.",
      );
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        let execution: WorkflowPreparation["execute"] = null;
        const admitted = yield* store.retry(input, observed, (request) =>
          prepare(request).pipe(
            Effect.map((prepared) => {
              execution = prepared.execute;
              return prepared.execute === null ? prepared.state : null;
            }),
          ),
        );
        if (admitted.blocked !== undefined)
          return { task: yield* currentTask(admitted.request), state: admitted.blocked };
        if (admitted.created && execution !== null) yield* launch(admitted.request, execution);
        return yield* snapshot(admitted.request);
      }),
    );
  });

  const cancel = Effect.fn("AxisTaskWorkflowService.cancel")(function* (
    caller: AxisProjectScopeCaller,
    raw: WorkflowCancel,
  ) {
    const input = yield* decodeCancel(raw).pipe(Effect.mapError(invalid));
    yield* authorize(caller, input, "write");
    const request = yield* load(input);
    const before = yield* observe(request);
    // An old cancel replay reads the old terminal attempt, even after a retry.
    if (terminal(before)) return yield* snapshot(request);
    const task = yield* currentTask(request);
    if (
      task.revision !== input.expectedRevision ||
      task.steps.find((step) => step.id === input.stepId)?.commandId !== input.commandId
    )
      return yield* error(
        "conflict",
        "The task revision or current attempt changed before cancellation.",
      );
    const stopping = Effect.scoped(
      Effect.gen(function* () {
        const worker = active.get(input.commandId);
        if (worker !== undefined) {
          // Executor interruption emits a real T3 interrupt and waits for provider
          // confirmation. It can affect only this command's dedicated thread.
          yield* Fiber.interrupt(worker);
        } else {
          const events = yield* engine.subscribeDomainEvents;
          const current = yield* observe(request);
          if (terminal(current)) return;
          if (current.status === "unknown")
            return yield* error(
              "cancel_unconfirmed",
              "The attempt has no unambiguous active turn to cancel. Reconcile its canonical history.",
            );
          const ended = yield* events.pipe(
            Stream.filter(
              (event) =>
                event.aggregateKind === "thread" &&
                event.aggregateId === current.execution.threadId,
            ),
            Stream.mapEffect((event) =>
              event.type === "thread.activity-appended" &&
              event.payload.activity.kind === "provider.turn.interrupt.failed"
                ? Effect.fail(
                    error(
                      "cancel_unconfirmed",
                      "The provider rejected interruption; its effect remains uncertain.",
                    ),
                  )
                : observe(request),
            ),
            Stream.filter(terminal),
            Stream.runHead,
            Effect.forkScoped,
          );
          const commandId = CommandId.make(`axis-workflow-cancel:${input.commandId}`);
          const existing = yield* receipts
            .getByCommandId({ commandId })
            .pipe(Effect.mapError(observationFailed));
          if (Option.isSome(existing)) {
            if (
              existing.value.aggregateKind !== "thread" ||
              existing.value.aggregateId !== current.execution.threadId ||
              existing.value.status === "rejected"
            )
              return yield* error(
                "cancel_unconfirmed",
                "The persisted interrupt receipt is rejected or belongs to another execution.",
              );
          } else {
            yield* engine
              .dispatch({
                type: "thread.turn.interrupt",
                commandId,
                threadId: current.execution.threadId,
                createdAt: request.task.updatedAt,
              })
              .pipe(
                Effect.mapError(() =>
                  error(
                    "cancel_unconfirmed",
                    "Interrupt dispatch failed; do not assume the provider stopped.",
                  ),
                ),
              );
          }
          // Subscription was acquired before dispatch and before the final read.
          if (!terminal(yield* observe(request))) yield* Fiber.join(ended);
        }
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: CANCELLATION_TIMEOUT_MS + 1_000,
        orElse: () =>
          Effect.fail(
            error(
              "cancel_unconfirmed",
              "Provider termination was not confirmed. Retry remains blocked until canonical failure/interruption is observed.",
            ),
          ),
      }),
    );
    yield* stopping;
    const result = yield* snapshot(request);
    if (!terminal(result.state))
      return yield* error(
        "cancel_unconfirmed",
        "The provider has not confirmed a terminal result; retry is not authorized.",
      );
    return result;
  });
  return { start, get, cancel, retry };
});

export class AxisTaskWorkflowService extends Context.Service<
  AxisTaskWorkflowService,
  Effect.Success<typeof make>
>()("t3/axis/tasks/AxisTaskWorkflowService") {}
export const layer = Layer.effect(AxisTaskWorkflowService, make);

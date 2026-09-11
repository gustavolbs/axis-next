// @effect-diagnostics nodeBuiltinImport:off - admission digest binds command replay to immutable inputs.
import * as NodeCrypto from "node:crypto";

import {
  AxisContextProjectScope,
  AxisTaskCommandConflictError,
  AxisTaskConflictError,
  AxisTaskPersistenceError,
  AxisTaskValidationError,
  CommandId,
  AxisWorkflowAdmission as WorkflowAdmission,
  AxisWorkflowRetryAdmission as WorkflowRetryAdmission,
  ThreadId,
  axisContextProjectScopeKey,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AxisTaskStore } from "./AxisTaskStore.ts";
import { attemptThreadId, WorkflowRequest, WorkflowState } from "./AxisTaskWorkflow.ts";

export { WorkflowAdmission, WorkflowRetryAdmission };

const decodeAdmission = Schema.decodeUnknownEffect(WorkflowAdmission);
const requestJson = Schema.fromJsonString(WorkflowRequest);
const decodeRequest = Schema.decodeUnknownEffect(requestJson);
const encodeRequest = Schema.encodeEffect(requestJson);
const encodeAdmission = Schema.encodeSync(Schema.fromJsonString(WorkflowAdmission));
const decodeRetry = Schema.decodeUnknownEffect(WorkflowRetryAdmission);
const encodeRetry = Schema.encodeSync(Schema.fromJsonString(WorkflowRetryAdmission));
const decodeState = Schema.decodeUnknownEffect(WorkflowState);
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const failure = (operation: string) => () => new AxisTaskPersistenceError({ operation });
type AttemptRow = {
  readonly commandId: string;
  readonly taskId: string;
  readonly stepId: string;
  readonly inputDigest: string;
  readonly requestJson: string;
};

/** Internal read-only preflight. Must never dispatch or call a provider: it runs
 * in the admission transaction before the attempt and metadata are written. */
export type WorkflowPreflight = (
  request: WorkflowRequest,
) => Effect.Effect<WorkflowState | null, AxisTaskValidationError>;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* AxisTaskStore;
  const decodeRow = Effect.fn("AxisTaskWorkflowStore.decodeRow")(function* (row: AttemptRow) {
    const request = yield* decodeRequest(row.requestJson).pipe(
      Effect.mapError(failure("decode workflow attempt")),
    );
    if (
      request.commandId !== row.commandId ||
      request.task.id !== row.taskId ||
      request.stepId !== row.stepId
    )
      return yield* new AxisTaskPersistenceError({
        operation: "validate workflow attempt identity",
      });
    return request;
  });
  const readCommand = (commandId: CommandId) =>
    sql<AttemptRow>`
    SELECT command_id AS "commandId", task_id AS "taskId", step_id AS "stepId",
           input_digest AS "inputDigest", request_json AS "requestJson"
    FROM axis_workflow_attempts WHERE command_id = ${commandId}
  `.pipe(Effect.mapError(failure("read workflow attempt")));

  const get = Effect.fn("AxisTaskWorkflowStore.get")(function* (
    scope: AxisContextProjectScope,
    threadId: ThreadId,
    commandId: CommandId,
  ) {
    const rows = yield* readCommand(commandId);
    if (rows[0] === undefined) return Option.none<WorkflowRequest>();
    const request = yield* decodeRow(rows[0]);
    if (
      request.task.threadId !== threadId ||
      axisContextProjectScopeKey(request.task.scope) !== axisContextProjectScopeKey(scope)
    )
      return Option.none<WorkflowRequest>();
    const current = yield* tasks.get(scope, threadId);
    return Option.isSome(current) && current.value.id === request.task.id
      ? Option.some(request)
      : Option.none<WorkflowRequest>();
  });

  const saveAdmission = Effect.fn("AxisTaskWorkflowStore.saveAdmission")(function* (
    input: WorkflowAdmission,
    previous?: { readonly commandId: CommandId; readonly observed: WorkflowState },
    preflight?: WorkflowPreflight,
  ) {
    const inputDigest = NodeCrypto.createHash("sha256")
      .update(
        previous === undefined
          ? encodeAdmission(input)
          : encodeRetry({ ...input, previousCommandId: previous.commandId }),
      )
      .digest("hex");
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* readCommand(input.commandId);
          if (rows[0] !== undefined) {
            if (rows[0].inputDigest !== inputDigest)
              return yield* new AxisTaskCommandConflictError({ commandId: input.commandId });
            const request = yield* decodeRow(rows[0]);
            return { request, created: false };
          }
          const current = yield* tasks.get(input.scope, input.threadId);
          if (Option.isNone(current) || current.value.id !== input.taskId)
            return yield* new AxisTaskValidationError({
              message: "The scoped task does not exist.",
            });
          const task = current.value;
          if (task.revision !== input.expectedRevision)
            return yield* new AxisTaskConflictError({ taskId: task.id });
          const step = task.steps.find((candidate) => candidate.id === input.stepId);
          if (step === undefined || task.status !== "active")
            return yield* new AxisTaskValidationError({
              message: "The step is unavailable or the task is paused.",
            });
          if (previous === undefined && (step.commandId !== null || step.status !== "not-executed"))
            return yield* new AxisTaskValidationError({
              message: "This step already has an attempt. Reconcile its result before retrying.",
            });
          if (previous !== undefined) {
            const old = yield* get(input.scope, input.threadId, previous.commandId);
            if (
              previous.commandId === input.commandId ||
              step.commandId !== previous.commandId ||
              Option.isNone(old) ||
              old.value.stepId !== input.stepId ||
              previous.observed.taskId !== task.id ||
              previous.observed.stepId !== step.id ||
              previous.observed.execution.commandId !== previous.commandId ||
              previous.observed.execution.threadId !== attemptThreadId(old.value) ||
              (previous.observed.status !== "failed" && previous.observed.status !== "interrupted")
            )
              return yield* new AxisTaskValidationError({
                message:
                  "Retry requires the current attempt's observed failure/interruption and a fresh command.",
              });
          }
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          // The old immutable request remains addressable by its command. Clear
          // only the retried step in the new execution snapshot: W03 must not
          // reinterpret the previous attempt with the retry's model selection.
          const requestTask =
            previous === undefined
              ? task
              : {
                  ...task,
                  steps: task.steps.map((candidate) =>
                    candidate.id === step.id
                      ? {
                          ...candidate,
                          status: "not-executed" as const,
                          commandId: null,
                          turnId: null,
                          reason: null,
                          startedAt: null,
                          finishedAt: null,
                        }
                      : candidate,
                  ),
                };
          const request: WorkflowRequest = {
            task: requestTask,
            stepId: input.stepId,
            commandId: input.commandId,
            modelSelection: input.modelSelection,
          };
          const blocked = preflight === undefined ? null : yield* preflight(request);
          if (blocked !== null) return { request, created: false, blocked };
          const json = yield* encodeRequest(request).pipe(
            Effect.mapError(failure("encode workflow attempt")),
          );
          yield* sql`
        INSERT INTO axis_workflow_attempts (command_id, task_id, step_id, input_digest, request_json, created_at)
        VALUES (${input.commandId}, ${task.id}, ${step.id}, ${inputDigest}, ${json}, ${createdAt})
      `;
          yield* tasks.update({
            task: {
              ...requestTask,
              revision: task.revision + 1,
              updatedAt: createdAt,
              steps: requestTask.steps.map((candidate) =>
                candidate.id === step.id
                  ? { ...candidate, commandId: input.commandId, startedAt: createdAt }
                  : candidate,
              ),
            },
            expectedRevision: input.expectedRevision,
            // Task mutation receipts are separate from canonical provider commands.
            commandId: CommandId.make(`axis-workflow-admit:${input.commandId}`),
          });
          return { request, created: true };
        }),
      )
      .pipe(Effect.catchTag("SqlError", () => Effect.fail(failure("admit workflow attempt")())));
  });

  const admit = Effect.fn("AxisTaskWorkflowStore.admit")(function* (
    raw: WorkflowAdmission,
    preflight?: WorkflowPreflight,
  ) {
    const input = yield* decodeAdmission(raw).pipe(
      Effect.mapError(
        () => new AxisTaskValidationError({ message: "Invalid workflow admission." }),
      ),
    );
    return yield* saveAdmission(input, undefined, preflight);
  });
  /** Internal observation comes from Workflow.getState, never from an RPC payload. */
  const retry = Effect.fn("AxisTaskWorkflowStore.retry")(function* (
    raw: WorkflowRetryAdmission,
    observed: WorkflowState,
    preflight?: WorkflowPreflight,
  ) {
    const input = yield* decodeRetry(raw).pipe(
      Effect.mapError(() => new AxisTaskValidationError({ message: "Invalid workflow retry." })),
    );
    const state = yield* decodeState(observed).pipe(
      Effect.mapError(() => new AxisTaskValidationError({ message: "Invalid retry observation." })),
    );
    return yield* saveAdmission(
      input,
      { commandId: input.previousCommandId, observed: state },
      preflight,
    );
  });

  /** Project legacy task metadata from canonical evidence, guarded by the current
   * command and task revision. A late old worker cannot settle a newer attempt.
   * No provider work occurs inside this short transaction.
   */
  const settle = Effect.fn("AxisTaskWorkflowStore.settle")(function* (
    request: WorkflowRequest,
    rawState: WorkflowState,
  ) {
    const state = yield* decodeState(rawState).pipe(
      Effect.mapError(
        () => new AxisTaskValidationError({ message: "Invalid workflow settlement." }),
      ),
    );
    if (
      state.taskId !== request.task.id ||
      state.stepId !== request.stepId ||
      state.execution.commandId !== request.commandId ||
      state.execution.threadId !== attemptThreadId(request)
    )
      return yield* new AxisTaskValidationError({
        message: "Settlement does not match the admitted attempt.",
      });
    if (
      state.status === "completed" &&
      (state.artifact === null ||
        state.execution.turnId === null ||
        state.artifact.execution.turnId !== state.execution.turnId ||
        state.artifact.execution.threadId !== state.execution.threadId ||
        state.artifact.execution.commandId !== request.commandId ||
        state.artifact.skillId !==
          request.task.steps.find((step) => step.id === request.stepId)?.skillId)
    )
      return yield* new AxisTaskValidationError({
        message: "Completion requires this attempt's canonical artifact.",
      });
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const stored = yield* get(request.task.scope, request.task.threadId, request.commandId);
          if (
            Option.isNone(stored) ||
            (yield* encodeRequest(stored.value)) !== (yield* encodeRequest(request))
          )
            return yield* new AxisTaskValidationError({
              message: "Settlement must use the immutable stored request.",
            });
          const current = yield* tasks.get(request.task.scope, request.task.threadId);
          if (Option.isNone(current)) return false;
          const task = current.value;
          const step = task.steps.find((entry) => entry.id === request.stepId);
          if (step?.commandId !== request.commandId) return false;
          const definition = (value: typeof task) =>
            json([
              value.title,
              value.acceptanceCriteria,
              value.workflowVersion,
              value.steps.map((entry) => [entry.id, entry.skillId]),
            ]);
          if (definition(task) !== definition(request.task)) return false;
          const status =
            state.status === "completed"
              ? "completed"
              : state.status === "failed" || state.status === "interrupted"
                ? "failed"
                : "not-executed";
          // A nonterminal read must not undo a terminal projection written by a
          // concurrent observer. Retry admission is the only way to reset it.
          if (
            (step.status === "completed" || step.status === "failed") &&
            status === "not-executed"
          )
            return false;
          const reason = state.reason?.slice(0, 2_000) ?? null;
          if (
            step.status === status &&
            step.turnId === state.execution.turnId &&
            step.reason === reason
          )
            return false;
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* tasks.update({
            task: {
              ...task,
              revision: task.revision + 1,
              updatedAt: now,
              steps: task.steps.map((entry) =>
                entry.id === step.id
                  ? {
                      ...entry,
                      status,
                      turnId: state.execution.turnId,
                      reason,
                      finishedAt:
                        status === "completed" || status === "failed"
                          ? (entry.finishedAt ?? now)
                          : null,
                    }
                  : entry,
              ),
            },
            expectedRevision: task.revision,
            commandId: CommandId.make(`axis-workflow-settle:${request.commandId}:${task.revision}`),
          });
          return true;
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: () => Effect.fail(failure("settle workflow attempt")()),
          SchemaError: () => Effect.fail(failure("encode workflow settlement")()),
          AxisTaskConflictError: () => Effect.succeed(false),
        }),
      );
  });
  return { admit, get, retry, settle };
});

export class AxisTaskWorkflowStore extends Context.Service<
  AxisTaskWorkflowStore,
  Effect.Success<typeof make>
>()("t3/axis/tasks/AxisTaskWorkflowStore") {}
export const layer = Layer.effect(AxisTaskWorkflowStore, make);

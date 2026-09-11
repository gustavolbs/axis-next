import { AxisLearningEvidenceId, type AxisLearningEvidence } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { AxisProjectScope, AxisProjectScopeCaller } from "../projects/AxisProjectScope.ts";
import { AxisTaskWorkflow, attemptThreadId } from "../tasks/AxisTaskWorkflow.ts";
import { AxisTaskWorkflowStore } from "../tasks/AxisTaskWorkflowStore.ts";
import { AxisLearningStore } from "./AxisLearningStore.ts";
import {
  AxisTaskFeedbackError,
  AxisTaskFeedbackRequest,
} from "../../../../../packages/contracts/src/axisTaskFeedback.ts";

const error = (reason: AxisTaskFeedbackError["reason"], message: string) =>
  new AxisTaskFeedbackError({ reason, message });
const observationFailed = () =>
  error("observation_failed", "Cannot read canonical task execution evidence.");
const decodeInput = Schema.decodeUnknownEffect(AxisTaskFeedbackRequest);
const decodeCaller = Schema.decodeUnknownEffect(AxisProjectScopeCaller);

/** Records an admitted execution attempt, not a claim that the entire task or
 * its tests succeeded. Callers are server-derived; transport capability checks
 * remain with RPC wiring. No dispatch, metadata settlement, or learning engine
 * invocation occurs here. Observation and evidence insertion share one short
 * SQLite snapshot so an external writer cannot replace the proof mid-record.
 */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const scopes = yield* AxisProjectScope;
  const attempts = yield* AxisTaskWorkflowStore;
  const workflow = yield* AxisTaskWorkflow;
  const projections = yield* ProjectionSnapshotQuery;
  const turns = yield* ProjectionTurnRepository;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const learning = yield* AxisLearningStore;

  const record = Effect.fn("AxisTaskFeedbackService.record")(function* (
    rawCaller: AxisProjectScopeCaller,
    raw: AxisTaskFeedbackRequest,
  ): Effect.fn.Return<AxisLearningEvidence, AxisTaskFeedbackError> {
    const caller = yield* decodeCaller(rawCaller, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => error("invalid_input", "Invalid server caller context.")),
    );
    const input = yield* decodeInput(raw, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() =>
        error(
          "invalid_input",
          "Feedback accepts scoped execution identifiers only, never factual outcomes or summaries.",
        ),
      ),
    );
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* scopes
            .resolveProject({ caller, scope: input.scope, operation: "write" })
            .pipe(
              Effect.mapError(() =>
                error("scope_denied", "The caller cannot record feedback for this project."),
              ),
            );
          const admitted = yield* attempts
            .get(input.scope, input.threadId, input.commandId)
            .pipe(Effect.mapError(observationFailed));
          if (Option.isNone(admitted))
            return yield* error(
              "not_found",
              "No persisted attempt belongs to this project and task thread.",
            );
          const request = admitted.value;
          if (request.task.id !== input.taskId || request.stepId !== input.stepId)
            return yield* error(
              "mismatch",
              "The task or step does not match this admitted command.",
            );
          if (request.task.purpose === "onboarding")
            return yield* error("mismatch", "Onboarding analysis is not task execution feedback.");
          const state = yield* workflow.getState(request).pipe(Effect.mapError(observationFailed));
          const threadId = attemptThreadId(request);
          if (
            state.taskId !== request.task.id ||
            state.stepId !== request.stepId ||
            state.execution.threadId !== threadId ||
            state.execution.commandId !== request.commandId
          )
            return yield* error(
              "mismatch",
              "Canonical state does not match the admitted execution.",
            );
          if (input.expectedTurnId !== undefined && input.expectedTurnId !== state.execution.turnId)
            return yield* error(
              "mismatch",
              "The expected turn is not this command's canonical turn.",
            );
          if (
            (state.status !== "completed" && state.status !== "failed") ||
            state.execution.turnId === null
          )
            return yield* error(
              "not_terminal",
              "Feedback requires a concrete completed or failed execution turn. Pending, interrupted and uncertain effects are not evidence.",
            );
          const receipt = yield* receipts
            .getByCommandId({ commandId: request.commandId })
            .pipe(Effect.mapError(observationFailed));
          if (
            Option.isNone(receipt) ||
            receipt.value.status !== "accepted" ||
            receipt.value.aggregateKind !== "thread" ||
            receipt.value.aggregateId !== threadId
          )
            return yield* error(
              "mismatch",
              "The accepted command receipt does not identify this execution thread.",
            );
          const rows = yield* turns
            .listByThreadId({ threadId })
            .pipe(Effect.mapError(observationFailed));
          const turn = rows[0];
          if (
            rows.length !== 1 ||
            turn === undefined ||
            turn.threadId !== threadId ||
            turn.turnId !== state.execution.turnId ||
            turn.pendingMessageId !== `axis-execution:${request.commandId}`
          )
            return yield* error(
              "mismatch",
              "The dedicated thread has missing or conflicting command/turn correlation.",
            );
          const shell = yield* projections
            .getThreadShellById(threadId)
            .pipe(Effect.mapError(observationFailed));
          if (
            Option.isNone(shell) ||
            shell.value.projectId !== request.task.scope.project.projectId ||
            shell.value.modelSelection.instanceId !== request.modelSelection.instanceId ||
            shell.value.modelSelection.model !== request.modelSelection.model
          )
            return yield* error(
              "mismatch",
              "The execution thread no longer matches its admitted project/provider.",
            );
          if (turn.completedAt === null || shell.value.session?.activeTurnId !== null)
            return yield* error(
              "not_terminal",
              "A terminal turn timestamp and idle provider session are required.",
            );
          if (state.status === "completed") {
            const artifact = state.artifact;
            if (
              turn.state !== "completed" ||
              artifact === null ||
              artifact.execution.threadId !== threadId ||
              artifact.execution.turnId !== turn.turnId ||
              artifact.execution.commandId !== request.commandId ||
              artifact.skillId !==
                request.task.steps.find((step) => step.id === request.stepId)?.skillId
            )
              return yield* error(
                "not_terminal",
                "Completion requires the canonical artifact for this exact step and turn.",
              );
          } else if (
            turn.state !== "error" ||
            (shell.value.session.status !== "error" && shell.value.session.status !== "stopped")
          ) {
            return yield* error(
              "not_terminal",
              "Failure requires the failed turn and a confirmed failed/stopped provider session.",
            );
          }
          const sourceId = `axis-task:${request.task.id}:thread:${threadId}:turn:${turn.turnId}:outcome:${state.status}`;
          const digest = NodeCrypto.createHash("sha256").update(sourceId).digest("hex");
          const createdAtDate = yield* DateTime.now;
          const createdAt = DateTime.formatIso(createdAtDate);
          return yield* learning
            .recordEvidence({
              id: AxisLearningEvidenceId.make(`axis-task-feedback-${digest}`),
              provenance: {
                contextId: request.task.scope.contextId,
                scope: request.task.scope,
                sourceKind: "thread-turn",
                sourceId,
                provider: {
                  environmentId: request.task.scope.project.environmentId,
                  instanceId: request.modelSelection.instanceId,
                },
                observedAt: turn.completedAt,
                fingerprint: `sha256:${digest}`,
              },
              summary:
                state.status === "completed"
                  ? "Task execution completed."
                  : "Task execution failed.",
              createdAt,
              expiresAt: DateTime.formatIso(DateTime.add(createdAtDate, { days: 30 })),
            })
            .pipe(
              Effect.mapError(() =>
                error("persistence_failed", "Cannot persist canonical task feedback."),
              ),
            );
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", () =>
          Effect.fail(error("persistence_failed", "Cannot atomically record task feedback.")),
        ),
      );
  });
  return { record };
});

export class AxisTaskFeedbackService extends Context.Service<
  AxisTaskFeedbackService,
  Effect.Success<typeof make>
>()("t3/axis/learning/AxisTaskFeedbackService") {}
export const layer = Layer.effect(AxisTaskFeedbackService, make);

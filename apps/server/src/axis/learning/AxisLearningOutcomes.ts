// @effect-diagnostics nodeBuiltinImport:off - stable outcome identities use SHA-256.
import * as NodeCrypto from "node:crypto";

import {
  AxisContextProjectScope,
  AxisLearningEvidenceId,
  AxisLearningVersionId,
  type AxisTaskFeedbackRequest,
  axisContextProjectScopeKey,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import type { AxisProjectScopeCaller } from "../projects/AxisProjectScope.ts";
import { AxisTaskStore } from "../tasks/AxisTaskStore.ts";
import { attemptThreadId } from "../tasks/AxisTaskWorkflow.ts";
import { AxisTaskWorkflowStore } from "../tasks/AxisTaskWorkflowStore.ts";
import { AxisLearningStore } from "./AxisLearningStore.ts";
import { AxisTaskFeedbackService } from "./AxisTaskFeedbackService.ts";

const OutcomeVersions = Schema.Array(AxisLearningVersionId);
const decodeVersions = Schema.decodeUnknownOption(OutcomeVersions);
const decodeScope = Schema.decodeUnknownEffect(AxisContextProjectScope);
const OUTCOME_PREFIX = "axis-learning-outcome:";
const OUTCOME_ID_PREFIX = "axis-learning-outcome-";

export class AxisLearningOutcomesError extends Schema.TaggedErrorClass<AxisLearningOutcomesError>()(
  "AxisLearningOutcomesError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

const failure = (operation: string, cause?: unknown) =>
  new AxisLearningOutcomesError({
    operation,
    message:
      typeof cause === "object" && cause !== null && "message" in cause
        ? String(cause.message)
        : `Cannot ${operation}.`,
  });

type ScopeRow = {
  readonly contextId: unknown;
  readonly environmentId: unknown;
  readonly projectId: unknown;
};

const runtimePayload = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* AxisTaskStore;
  const attempts = yield* AxisTaskWorkflowStore;
  const feedback = yield* AxisTaskFeedbackService;
  const learning = yield* AxisLearningStore;
  const directory = yield* ProviderSessionDirectory;

  const record = Effect.fn("AxisLearningOutcomes.record")(function* (
    caller: AxisProjectScopeCaller,
    input: AxisTaskFeedbackRequest,
  ) {
    const canonical = yield* feedback
      .record(caller, input)
      .pipe(Effect.mapError((cause) => failure("reconcile canonical task feedback", cause)));
    const request = yield* attempts
      .get(input.scope, input.threadId, input.commandId)
      .pipe(Effect.mapError((cause) => failure("read the admitted workflow attempt", cause)));
    if (Option.isNone(request)) return yield* failure("find the admitted workflow attempt");
    const binding = yield* directory
      .getBinding(attemptThreadId(request.value))
      .pipe(Effect.mapError((cause) => failure("read the provider execution binding", cause)));
    const rawVersions = Option.isSome(binding)
      ? runtimePayload(binding.value.runtimePayload).axisLearningVersionIds
      : undefined;
    const decodedVersions = rawVersions === undefined ? undefined : decodeVersions(rawVersions);
    const versionKeys =
      decodedVersions === undefined
        ? (["unrecorded"] as const)
        : Option.isNone(decodedVersions) || decodedVersions.value.length === 0
          ? (["none"] as const)
          : [...new Set(decodedVersions.value)].sort();
    const outcomes = yield* Effect.forEach(versionKeys, (versionKey) => {
      const identity = {
        origin: canonical.provenance.sourceId,
        version: versionKey,
        scope: axisContextProjectScopeKey(input.scope),
      };
      const fingerprint = `sha256:${digest(identity)}`;
      const sourceId = `${OUTCOME_PREFIX}${digest(canonical.provenance.sourceId)}`;
      const versionLabel =
        versionKey === "unrecorded"
          ? "execution metadata did not record a Learning version"
          : versionKey === "none"
            ? "no learned version was active"
            : `Learning version '${versionKey}' was active`;
      return learning
        .recordEvidence({
          id: AxisLearningEvidenceId.make(`${OUTCOME_ID_PREFIX}${digest(identity)}`),
          provenance: {
            ...canonical.provenance,
            sourceKind: "evaluation",
            sourceId,
            cursor: versionKey,
            fingerprint,
          },
          summary: `${canonical.summary.slice(0, 1_200)} ${versionLabel}. This single execution is evidence for review, not proof that a Learning change improved or degraded the project.`,
          createdAt: canonical.createdAt,
          expiresAt: canonical.expiresAt,
        })
        .pipe(Effect.mapError((cause) => failure("persist the Learning outcome", cause)));
    });
    return { canonical, outcomes };
  });

  const reconcileScope = Effect.fn("AxisLearningOutcomes.reconcileScope")(function* (
    scope: AxisContextProjectScope,
  ) {
    const current = yield* tasks
      .list(scope)
      .pipe(
        Effect.mapError((cause) => failure("list scoped tasks for outcome reconciliation", cause)),
      );
    let recorded = 0;
    yield* Effect.forEach(
      current,
      (task) =>
        Effect.forEach(
          task.steps,
          (step) => {
            if (
              (step.status !== "completed" && step.status !== "failed") ||
              step.commandId === null ||
              step.turnId === null
            )
              return Effect.void;
            return record(
              { environmentId: scope.project.environmentId, contextId: scope.contextId },
              {
                scope,
                threadId: task.threadId,
                taskId: task.id,
                stepId: step.id,
                commandId: step.commandId,
                expectedTurnId: step.turnId,
              },
            ).pipe(
              Effect.tap(({ outcomes }) =>
                Effect.sync(() => {
                  recorded += outcomes.length;
                }),
              ),
              Effect.catch((cause) =>
                Effect.logDebug("Axis Learning outcome is not reconcilable yet", {
                  taskId: task.id,
                  stepId: step.id,
                  cause: String(cause),
                }),
              ),
            );
          },
          { discard: true },
        ),
      { concurrency: 4, discard: true },
    );
    return recorded;
  });

  const list = Effect.fn("AxisLearningOutcomes.list")(function* (scope: AxisContextProjectScope) {
    yield* reconcileScope(scope);
    const evidence = yield* learning
      .listEvidence(scope.contextId, scope)
      .pipe(Effect.mapError((cause) => failure("read Learning outcomes", cause)));
    return evidence.filter(
      (entry) =>
        entry.provenance.sourceKind === "evaluation" &&
        entry.provenance.sourceId.startsWith(OUTCOME_PREFIX),
    );
  });

  const reconcileAll = Effect.fn("AxisLearningOutcomes.reconcileAll")(function* () {
    const rows = yield* sql<ScopeRow>`
      SELECT DISTINCT
        context_id AS "contextId",
        environment_id AS "environmentId",
        project_id AS "projectId"
      FROM axis_task_extensions
    `.pipe(
      Effect.mapError((cause) => failure("list task scopes for outcome reconciliation", cause)),
    );
    const scopes = yield* Effect.forEach(rows, (row) =>
      decodeScope({
        contextId: row.contextId,
        project: { environmentId: row.environmentId, projectId: row.projectId },
      }).pipe(Effect.mapError((cause) => failure("decode a task outcome scope", cause))),
    );
    const counts = yield* Effect.forEach(scopes, reconcileScope, { concurrency: 4 });
    return counts.reduce((total, count) => total + count, 0);
  });

  return { record, reconcileScope, reconcileAll, list };
});

export class AxisLearningOutcomes extends Context.Service<
  AxisLearningOutcomes,
  Effect.Success<typeof make>
>()("t3/axis/learning/AxisLearningOutcomes") {}

const triggersReconciliation = (event: { readonly type: string; readonly aggregateId: string }) =>
  event.aggregateId.startsWith("axis-workflow-") &&
  [
    "thread.session-set",
    "thread.turn-diff-completed",
    "thread.reverted",
    "thread.checkpoint-revert-requested",
  ].includes(event.type);

export const layer = Layer.effect(
  AxisLearningOutcomes,
  Effect.gen(function* () {
    const service = yield* make;
    const engine = yield* OrchestrationEngineService;
    const events = yield* engine.subscribeDomainEvents;
    yield* events.pipe(
      Stream.filter(triggersReconciliation),
      Stream.runForEach(() =>
        service
          .reconcileAll()
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Axis Learning outcome reconciliation failed", { cause }),
            ),
          ),
      ),
      Effect.forkScoped,
    );
    // Subscription is acquired before the initial durable scan, closing the
    // startup window without introducing a second event log.
    yield* service
      .reconcileAll()
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Initial Axis Learning outcome reconciliation failed", { cause }),
        ),
      );
    return service;
  }),
);

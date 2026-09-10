// @effect-diagnostics nodeBuiltinImport:off - run ids are stable T3 command keys.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId } from "@t3tools/contracts";

import {
  AxisOnboardingSourceId,
  AxisOnboardingRunId,
  type AxisOnboardingApplyInput,
  type AxisOnboardingProgress as AxisOnboardingProgressType,
  type AxisOnboardingRun as AxisOnboardingRunType,
  type AxisOnboardingRunId as AxisOnboardingRunIdType,
  type AxisOnboardingCancelInput,
  type AxisOnboardingRetryInput,
  type AxisOnboardingStartRequest,
} from "../../../../../packages/contracts/src/axisOnboarding.ts";
import type {
  AxisContextProjectScope,
  AxisProjectProfile,
  AxisProjectRuleId,
} from "../../../../../packages/contracts/src/axisProjectProfile.ts";
import * as AxisProjectProfileStore from "../projects/AxisProjectProfileStore.ts";
import * as AxisProjectScope from "../projects/AxisProjectScope.ts";
import { AxisTaskExecution } from "../tasks/AxisTaskExecution.ts";
import { analyzeAxisOnboarding } from "./AxisOnboardingAnalysis.ts";
import { onboardingPrompt } from "./AxisOnboardingPrompt.ts";
import { AxisOnboardingApplyError } from "./AxisOnboardingApply.ts";
import { applyAxisOnboardingPersistence } from "./AxisOnboardingPersistence.ts";
import { deriveProjectFacts } from "./AxisProjectFacts.ts";
import * as AxisProjectSources from "./AxisProjectSources.ts";
import * as AxisOnboardingStore from "./AxisOnboardingStore.ts";

const TOTAL_STEPS = 3;

export class AxisOnboardingServiceValidationError extends Schema.TaggedErrorClass<AxisOnboardingServiceValidationError>()(
  "AxisOnboardingServiceValidationError",
  { message: Schema.String },
) {}

export type AxisOnboardingServiceError =
  | AxisOnboardingServiceValidationError
  | AxisOnboardingStore.AxisOnboardingStoreError
  | AxisProjectProfileStore.AxisProjectProfileStoreError
  | AxisOnboardingApplyError;

export interface AxisOnboardingRunSnapshot {
  readonly run: AxisOnboardingRunType;
  readonly progress: AxisOnboardingProgressType;
}

export interface AxisOnboardingApplyResponse {
  readonly run: AxisOnboardingRunSnapshot;
  readonly profile: AxisProjectProfile;
  readonly invalidatedRuleIds: ReadonlyArray<AxisProjectRuleId>;
  readonly acceptedCandidateIds: ReadonlyArray<
    AxisOnboardingRunType["candidateRules"][number]["id"]
  >;
}

const runKey = (scope: AxisContextProjectScope, runId: AxisOnboardingRunIdType) =>
  `${scope.contextId}:${scope.project.environmentId}:${scope.project.projectId}:${runId}`;

const makeRunId = (input: AxisOnboardingStartRequest): AxisOnboardingRunIdType =>
  AxisOnboardingRunId.make(
    `onboarding-${NodeCrypto.createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 48)}`,
  );

const validationError = (message: string) => new AxisOnboardingServiceValidationError({ message });

const sourceId = (path: string) =>
  AxisOnboardingSourceId.make(
    `source-${NodeCrypto.createHash("sha256").update(path, "utf8").digest("hex").slice(0, 32)}`,
  );

const diagnostic = (cause: unknown) => {
  if (cause instanceof Error && /401|invalid_api_key|unauthorized/i.test(cause.message)) {
    return "Provider authentication failed. Check this environment's provider credentials in Settings, then retry.";
  }
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message.slice(0, 8_000);
  if (typeof cause === "string" && cause.trim() !== "") return cause.slice(0, 8_000);
  return "Onboarding execution failed.";
};

const progressFor = (run: AxisOnboardingRunType): AxisOnboardingProgressType => {
  if (run.status === "cancelled") {
    return {
      stage: "cancelled",
      completedSteps: Math.min(
        TOTAL_STEPS,
        run.facts.length > 0 ? 2 : run.sources.length > 0 ? 1 : 0,
      ),
      totalSteps: TOTAL_STEPS,
      message: "Onboarding was cancelled before it could be applied.",
    };
  }
  if (run.status === "failed") {
    return {
      stage: "failed",
      completedSteps: Math.min(
        TOTAL_STEPS,
        run.facts.length > 0 ? 2 : run.sources.length > 0 ? 1 : 0,
      ),
      totalSteps: TOTAL_STEPS,
      message: run.error,
    };
  }
  if (run.status === "completed") {
    return {
      stage: "completed",
      completedSteps: TOTAL_STEPS,
      totalSteps: TOTAL_STEPS,
      message: "Onboarding analysis completed and is ready for review.",
    };
  }
  if (run.candidateRules.length > 0 || run.conflicts.length > 0) {
    return {
      stage: "ready",
      completedSteps: TOTAL_STEPS,
      totalSteps: TOTAL_STEPS,
      message: "Onboarding candidates are ready for review.",
    };
  }
  if (run.sources.length > 0) {
    return {
      stage: "analyzing",
      completedSteps: 2,
      totalSteps: TOTAL_STEPS,
      message:
        run.facts.length > 0
          ? "Project facts were collected; onboarding analysis is in progress."
          : "Sources were collected without structured facts; onboarding analysis is in progress.",
    };
  }
  return {
    stage: "collecting",
    completedSteps: run.sources.length > 0 ? 1 : 0,
    totalSteps: TOTAL_STEPS,
    message:
      run.sources.length > 0
        ? "Project sources were collected; deriving project facts."
        : "Collecting bounded project sources.",
  };
};

const snapshot = (run: AxisOnboardingRunType): AxisOnboardingRunSnapshot => ({
  run,
  progress: progressFor(run),
});

export class AxisOnboardingService extends Context.Service<
  AxisOnboardingService,
  {
    readonly list: (
      scope: AxisContextProjectScope,
    ) => Effect.Effect<ReadonlyArray<AxisOnboardingRunSnapshot>, AxisOnboardingServiceError>;
    readonly get: (
      scope: AxisContextProjectScope,
      runId: AxisOnboardingRunId,
    ) => Effect.Effect<AxisOnboardingRunSnapshot, AxisOnboardingServiceError>;
    readonly start: (
      input: AxisOnboardingStartRequest,
    ) => Effect.Effect<AxisOnboardingRunSnapshot, AxisOnboardingServiceError>;
    readonly cancel: (
      scope: AxisContextProjectScope,
      input: AxisOnboardingCancelInput,
    ) => Effect.Effect<AxisOnboardingRunSnapshot, AxisOnboardingServiceError>;
    readonly retry: (
      scope: AxisContextProjectScope,
      input: AxisOnboardingRetryInput,
    ) => Effect.Effect<AxisOnboardingRunSnapshot, AxisOnboardingServiceError>;
    readonly apply: (
      input: AxisOnboardingApplyInput,
    ) => Effect.Effect<AxisOnboardingApplyResponse, AxisOnboardingServiceError>;
  }
>()("t3/axis/onboarding/AxisOnboardingService") {}

export const make = Effect.gen(function* () {
  const runs = yield* AxisOnboardingStore.AxisOnboardingStore;
  const profiles = yield* AxisProjectProfileStore.AxisProjectProfileStore;
  const sql = yield* SqlClient.SqlClient;
  const projectSources = yield* AxisProjectSources.AxisProjectSources;
  const projectScope = yield* AxisProjectScope.AxisProjectScope;
  const executor = yield* AxisTaskExecution;
  const runtimeScope = yield* Effect.scope;
  const writes = yield* Semaphore.make(1);
  const starts = yield* Semaphore.make(1);
  const activeRuns = new Map<string, Fiber.Fiber<unknown, unknown>>();

  const getRun = (
    scope: AxisContextProjectScope,
    runId: AxisOnboardingRunId,
  ): Effect.Effect<AxisOnboardingRunType, AxisOnboardingServiceError> =>
    runs
      .get(scope, runId)
      .pipe(
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.succeed(result.value)
            : Effect.fail(
                validationError(`Onboarding run ${runId} was not found in this project.`),
              ),
        ),
      );

  const list: AxisOnboardingService["Service"]["list"] = (scope) =>
    runs.list(scope).pipe(
      Effect.flatMap((items) => Effect.forEach(items, recoverInterruptedRun)),
      Effect.map((items) => items.map(snapshot)),
    );

  const get: AxisOnboardingService["Service"]["get"] = (scope, runId) =>
    getRun(scope, runId).pipe(Effect.flatMap(recoverInterruptedRun), Effect.map(snapshot));

  const saveWhileRunning = (
    scope: AxisContextProjectScope,
    runId: AxisOnboardingRunIdType,
    commandId: AxisOnboardingRunType["execution"]["commandId"],
    update: (run: AxisOnboardingRunType) => AxisOnboardingRunType,
  ) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* runs.get(scope, runId);
        if (
          Option.isNone(current) ||
          current.value.status !== "running" ||
          current.value.execution.commandId !== commandId
        )
          return false;
        yield* runs.save(update(current.value));
        return true;
      }),
    );

  const markFailed = (
    scope: AxisContextProjectScope,
    runId: AxisOnboardingRunIdType,
    cause: unknown,
    commandId?: AxisOnboardingRunType["execution"]["commandId"],
  ) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* runs.get(scope, runId);
        if (
          Option.isNone(current) ||
          current.value.status !== "running" ||
          (commandId !== undefined && current.value.execution.commandId !== commandId)
        )
          return;
        const failed: AxisOnboardingRunType = {
          ...current.value,
          status: "failed",
          error: diagnostic(cause),
          finishedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* runs.save(failed);
      }),
    );

  const runPipeline = (initial: AxisOnboardingRunType) =>
    Effect.gen(function* () {
      if (initial.modelSelection === undefined) {
        return yield* validationError(
          "This older run has no provider selection. Start a new analysis.",
        );
      }
      const sourceScope = yield* projectScope.resolve({
        caller: {
          environmentId: initial.scope.project.environmentId,
          contextId: initial.scope.contextId,
        },
        scope: initial.scope,
        operation: "execute",
        provider: {
          environmentId: initial.scope.project.environmentId,
          instanceId: initial.modelSelection.instanceId,
        },
      });
      const inventory = yield* projectSources.collect(sourceScope);
      const observedAt = DateTime.formatIso(yield* DateTime.now);
      const factsResult = deriveProjectFacts(inventory, observedAt);
      const sources = inventory.sources.map((source) => {
        const warning =
          factsResult.diagnostics.find(
            (item) => item.path === source.path && item.status === "invalid",
          )?.message ??
          (source.truncated ? "Source content was truncated to the collection limit." : undefined);
        const base = {
          id: sourceId(source.path),
          path: source.path,
          kind: source.kind,
          ...(warning ? { warning } : {}),
        };
        if (source.status === "read") {
          return { ...base, status: "read" as const, error: null };
        }
        if (source.status === "absent") {
          return { ...base, status: "absent" as const, error: null };
        }
        return {
          ...base,
          status: "failed" as const,
          error: source.error ?? "The source could not be read.",
        };
      });
      const profile = yield* profiles.get(initial.scope);
      const collected: AxisOnboardingRunType = {
        ...initial,
        sources,
        digests: factsResult.digests,
        facts: factsResult.facts,
      };
      if (
        !(yield* saveWhileRunning(
          initial.scope,
          initial.id,
          initial.execution.commandId,
          () => collected,
        ))
      ) {
        return;
      }

      const analysisInput = {
        scope: initial.scope,
        sources: sources.map((source, index) => ({
          ...source,
          content: inventory.sources[index]?.content ?? null,
        })),
        facts: factsResult.facts,
        effectiveContext: { scope: initial.scope, rules: profile.rules },
      };
      const output = yield* executor.execute({
        scope: initial.scope,
        threadId: initial.execution.threadId,
        commandId: initial.execution.commandId,
        modelSelection: initial.modelSelection,
        prompt: onboardingPrompt(analysisInput),
        runtimeMode: "approval-required",
        onTurnStarted: (execution) =>
          saveWhileRunning(initial.scope, initial.id, initial.execution.commandId, (current) => ({
            ...current,
            execution,
          })).pipe(Effect.asVoid),
      });
      const analysis = yield* Effect.try({
        try: () => analyzeAxisOnboarding({ ...analysisInput, modelOutput: output.text }),
        catch: (error) => validationError(diagnostic(error)),
      });
      const completed: AxisOnboardingRunType = {
        ...collected,
        execution: output.execution,
        candidateRules: analysis.candidateRules,
        conflicts: analysis.conflicts,
        status: "completed",
        error: null,
        finishedAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* saveWhileRunning(
        initial.scope,
        initial.id,
        initial.execution.commandId,
        () => completed,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? markFailed(
              initial.scope,
              initial.id,
              "Analysis was interrupted before completion. Review its thread before retrying.",
              initial.execution.commandId,
            )
          : markFailed(initial.scope, initial.id, Cause.squash(cause), initial.execution.commandId),
      ),
      Effect.ensuring(Effect.sync(() => activeRuns.delete(runKey(initial.scope, initial.id)))),
    );

  const recoverInterruptedRun = (run: AxisOnboardingRunType) =>
    run.status !== "running" || activeRuns.has(runKey(run.scope, run.id))
      ? Effect.succeed(run)
      : markFailed(
          run.scope,
          run.id,
          "The server restarted before this analysis settled. Review its thread, then retry explicitly.",
          run.execution.commandId,
        ).pipe(Effect.andThen(getRun(run.scope, run.id)));

  const launch = (run: AxisOnboardingRunType) => {
    const key = runKey(run.scope, run.id);
    if (activeRuns.has(key)) return Effect.void;
    return Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const fiber = yield* Deferred.await(ready).pipe(
        Effect.andThen(runPipeline(run)),
        Effect.forkIn(runtimeScope),
      );
      activeRuns.set(key, fiber);
      yield* Deferred.succeed(ready, undefined);
    });
  };

  const start: AxisOnboardingService["Service"]["start"] = (input) =>
    starts.withPermits(1)(
      Effect.gen(function* () {
        const id = makeRunId(input);
        const existing = yield* runs.get(input.scope, id);
        if (Option.isSome(existing)) {
          if (existing.value.status === "running" && !activeRuns.has(runKey(input.scope, id))) {
            yield* markFailed(
              input.scope,
              id,
              "The server restarted before this analysis settled. Review its thread, then retry explicitly.",
            );
            return yield* get(input.scope, id);
          }
          return snapshot(existing.value);
        }

        const startedAt = DateTime.formatIso(yield* DateTime.now);
        const run: AxisOnboardingRunType = {
          id,
          scope: input.scope,
          execution: {
            threadId: ThreadId.make(`${id}-thread`),
            turnId: null,
            commandId: input.commandId,
          },
          modelSelection: input.modelSelection,
          status: "running",
          sources: [],
          digests: [],
          facts: [],
          candidateRules: [],
          conflicts: [],
          decisions: [],
          error: null,
          startedAt,
          finishedAt: null,
        };
        const started = yield* runs.start({ run });
        yield* launch(started);
        return snapshot(started);
      }),
    );

  const cancel: AxisOnboardingService["Service"]["cancel"] = (scope, input) =>
    Effect.gen(function* () {
      const cancelled = yield* writes.withPermits(1)(runs.cancel(scope, input));
      // A replay returns the current run, which may already be a new attempt.
      // The old cancellation receipt does not authorize interrupting that attempt.
      if (cancelled.status !== "cancelled") return snapshot(cancelled);
      const fiber = activeRuns.get(runKey(scope, input.runId));
      if (fiber !== undefined) {
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
        activeRuns.delete(runKey(scope, input.runId));
      }
      return snapshot(cancelled);
    });

  const retry: AxisOnboardingService["Service"]["retry"] = (scope, input) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        if (activeRuns.has(runKey(scope, input.runId))) {
          return yield* validationError(
            "The previous analysis is still stopping. Retry after cancellation completes.",
          );
        }
        const current = yield* getRun(scope, input.runId);
        if (current.modelSelection === undefined) {
          return yield* validationError(
            "This older run has no provider selection. Start a new analysis.",
          );
        }
        const retried = yield* runs.retry(scope, input);
        // A replay may return a later terminal run. Never repeat provider effects.
        if (retried.status === "running" && current.execution.commandId !== input.commandId) {
          yield* launch(retried);
        }
        return snapshot(retried);
      }),
    );

  const apply: AxisOnboardingService["Service"]["apply"] = (input) =>
    Effect.gen(function* () {
      const decidedAt = DateTime.formatIso(yield* DateTime.now);
      return yield* applyAxisOnboardingPersistence({ ...input, decidedAt }).pipe(
        Effect.provideService(AxisOnboardingStore.AxisOnboardingStore, runs),
        Effect.provideService(AxisProjectProfileStore.AxisProjectProfileStore, profiles),
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    });

  return { list, get, start, cancel, retry, apply } satisfies AxisOnboardingService["Service"];
});

export const layer = Layer.effect(AxisOnboardingService, make);

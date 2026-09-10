// @effect-diagnostics nodeBuiltinImport:off - run ids are stable T3 command keys.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

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
  AxisTypedChange,
} from "../../../../../packages/contracts/src/axisProjectProfile.ts";
import * as AxisProjectProfileStore from "../projects/AxisProjectProfileStore.ts";
import type * as AxisProjectScope from "../projects/AxisProjectScope.ts";
import type { AxisOnboardingAnalysisResult } from "./AxisOnboardingAnalysis.ts";
import { applyAxisOnboarding, AxisOnboardingApplyError } from "./AxisOnboardingApply.ts";
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

const sameScope = (left: AxisContextProjectScope, right: AxisContextProjectScope) =>
  left.contextId === right.contextId &&
  left.project.environmentId === right.project.environmentId &&
  left.project.projectId === right.project.projectId;

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

const inputScope = (scope: AxisContextProjectScope): AxisProjectScope.AxisResolvedProjectScope =>
  scope as unknown as AxisProjectScope.AxisResolvedProjectScope;

const diagnostic = (cause: unknown) => {
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
  if (run.facts.length > 0) {
    return {
      stage: "analyzing",
      completedSteps: 2,
      totalSteps: TOTAL_STEPS,
      message: "Project facts were collected; onboarding analysis is in progress.",
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

const changesFor = (
  previousProfile: AxisProjectProfile,
  nextProfile: AxisProjectProfile,
): ReadonlyArray<AxisTypedChange> => {
  const previous = new Map(previousProfile.rules.map((rule) => [rule.id, rule]));
  const next = new Map(nextProfile.rules.map((rule) => [rule.id, rule]));
  const changes: AxisTypedChange[] = [];

  for (const rule of previousProfile.rules) {
    if (!next.has(rule.id) && previous.has(rule.id)) {
      changes.push({ op: "remove-rule", ruleId: rule.id });
    }
  }
  for (const rule of next.values()) {
    const existing = previous.get(rule.id);
    if (existing === undefined || JSON.stringify(existing) !== JSON.stringify(rule)) {
      changes.push({ op: "set-rule", rule });
    }
  }
  return changes;
};

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
  const projectSources = yield* AxisProjectSources.AxisProjectSources;
  const writes = yield* Semaphore.make(1);
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
    runs.list(scope).pipe(Effect.map((items) => items.map(snapshot)));

  const get: AxisOnboardingService["Service"]["get"] = (scope, runId) =>
    getRun(scope, runId).pipe(Effect.map(snapshot));

  const saveWhileRunning = (
    scope: AxisContextProjectScope,
    runId: AxisOnboardingRunIdType,
    update: (run: AxisOnboardingRunType) => AxisOnboardingRunType,
  ) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* runs.get(scope, runId);
        if (Option.isNone(current) || current.value.status !== "running") return false;
        yield* runs.save(update(current.value));
        return true;
      }),
    );

  const markFailed = (
    scope: AxisContextProjectScope,
    runId: AxisOnboardingRunIdType,
    cause: unknown,
  ) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* runs.get(scope, runId);
        if (Option.isNone(current) || current.value.status !== "running") return;
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
      // AxisProjectSources currently consumes the resolved scope shape, while the
      // public onboarding request intentionally carries only the project scope.
      // Its live implementation reads the project by the nested scope fields.
      const sourceScope = inputScope(initial.scope);
      const inventory = yield* projectSources.collect(sourceScope);
      const observedAt = DateTime.formatIso(yield* DateTime.now);
      const sources = inventory.sources.map((source) => {
        const base = { id: sourceId(source.path), path: source.path, kind: source.kind };
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
      const factsResult = deriveProjectFacts(inventory, observedAt);
      const profile = yield* profiles.get(initial.scope);
      const collected: AxisOnboardingRunType = {
        ...initial,
        sources,
        digests: factsResult.digests,
        facts: factsResult.facts,
      };
      if (!(yield* saveWhileRunning(initial.scope, initial.id, () => collected))) {
        return;
      }

      // No provider output is part of AxisOnboardingStartRequest yet. A safe,
      // explicit no-candidate result keeps observed facts reviewable without
      // inventing policy from repository metadata.
      const analysis: AxisOnboardingAnalysisResult = {
        scope: initial.scope,
        candidateRules: [],
        conflicts: [],
        branch: {
          sourceFacts: factsResult.facts,
          pullRequestPolicies: profile.rules,
        },
      };
      const completed: AxisOnboardingRunType = {
        ...collected,
        candidateRules: analysis.candidateRules,
        conflicts: analysis.conflicts,
        status: "completed",
        error: null,
        finishedAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* saveWhileRunning(initial.scope, initial.id, () => completed);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : markFailed(initial.scope, initial.id, Cause.pretty(cause)),
      ),
      Effect.ensuring(Effect.sync(() => activeRuns.delete(runKey(initial.scope, initial.id)))),
    );

  const launch = (run: AxisOnboardingRunType) => {
    const key = runKey(run.scope, run.id);
    if (activeRuns.has(key)) return Effect.void;
    return runPipeline(run).pipe(
      Effect.forkDetach,
      Effect.tap((fiber) => Effect.sync(() => activeRuns.set(key, fiber))),
      Effect.asVoid,
    );
  };

  const start: AxisOnboardingService["Service"]["start"] = (input) =>
    Effect.gen(function* () {
      const id = makeRunId(input);
      const existing = yield* runs.get(input.scope, id);
      if (Option.isSome(existing)) {
        if (existing.value.status === "running" && !activeRuns.has(runKey(input.scope, id))) {
          yield* launch(existing.value);
        }
        return snapshot(existing.value);
      }

      const startedAt = DateTime.formatIso(yield* DateTime.now);
      const run: AxisOnboardingRunType = {
        id,
        scope: input.scope,
        execution: input.execution,
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
    });

  const cancel: AxisOnboardingService["Service"]["cancel"] = (scope, input) =>
    Effect.gen(function* () {
      const cancelled = yield* writes.withPermits(1)(runs.cancel(scope, input));
      const fiber = activeRuns.get(runKey(scope, input.runId));
      if (fiber !== undefined) {
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
        activeRuns.delete(runKey(scope, input.runId));
      }
      return snapshot(cancelled);
    });

  const retry: AxisOnboardingService["Service"]["retry"] = (scope, input) =>
    Effect.gen(function* () {
      const retried = yield* runs.retry(scope, input);
      const reset: AxisOnboardingRunType = {
        ...retried,
        sources: [],
        digests: [],
        facts: [],
        candidateRules: [],
        conflicts: [],
        decisions: [],
      };
      yield* writes.withPermits(1)(runs.save(reset));
      yield* launch(reset);
      return snapshot(reset);
    });

  const apply: AxisOnboardingService["Service"]["apply"] = (input) =>
    Effect.gen(function* () {
      const run = yield* getRun(input.scope, input.runId);
      if (!sameScope(run.scope, input.scope)) {
        return yield* validationError("The onboarding run belongs to another project.");
      }
      const profile = yield* profiles.get(input.scope);
      const decidedAt = DateTime.formatIso(yield* DateTime.now);
      const result = yield* Effect.try({
        try: () =>
          applyAxisOnboarding({
            profile,
            run,
            decisions: input.decisions,
            expectedProfileRevision: input.expectedProfileRevision,
            decidedAt,
          }),
        catch: (cause) =>
          cause instanceof AxisOnboardingApplyError
            ? cause
            : new AxisOnboardingApplyError(
                "invalid_run",
                "The onboarding result could not be applied.",
              ),
      });

      const changes = changesFor(profile, result.profile);
      const savedProfile =
        changes.length === 0
          ? profile
          : yield* profiles.replace(input.scope, input.expectedProfileRevision, changes);
      const savedRun: AxisOnboardingRunType = { ...run, decisions: [...input.decisions] };
      yield* runs.save(savedRun);
      return {
        run: snapshot(savedRun),
        profile: savedProfile,
        invalidatedRuleIds: result.invalidatedRuleIds,
        acceptedCandidateIds: result.acceptedCandidateIds,
      } satisfies AxisOnboardingApplyResponse;
    });

  return { list, get, start, cancel, retry, apply } satisfies AxisOnboardingService["Service"];
});

export const layer = Layer.effect(AxisOnboardingService, make);

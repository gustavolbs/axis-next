/** Contracts for the explicit, reviewable Axis project onboarding flow. */
import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedString,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { AxisContextProjectScope, AxisProjectRuleCategory } from "./axisProjectProfile.ts";

const ENTITY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const onboardingId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.check(Schema.isMaxLength(128), Schema.isPattern(ENTITY_ID_PATTERN)).pipe(
    Schema.brand(brand),
  );
const boundedText = TrimmedString.check(Schema.isMaxLength(8_000));
const boundedNonEmptyText = TrimmedNonEmptyString.check(Schema.isMaxLength(8_000));

export const AxisOnboardingRunId = onboardingId("AxisOnboardingRunId");
export type AxisOnboardingRunId = typeof AxisOnboardingRunId.Type;
export const AxisOnboardingSourceId = onboardingId("AxisOnboardingSourceId");
export type AxisOnboardingSourceId = typeof AxisOnboardingSourceId.Type;
export const AxisOnboardingDigestId = onboardingId("AxisOnboardingDigestId");
export type AxisOnboardingDigestId = typeof AxisOnboardingDigestId.Type;
export const AxisOnboardingFactId = onboardingId("AxisOnboardingFactId");
export type AxisOnboardingFactId = typeof AxisOnboardingFactId.Type;
export const AxisOnboardingCandidateRuleId = onboardingId("AxisOnboardingCandidateRuleId");
export type AxisOnboardingCandidateRuleId = typeof AxisOnboardingCandidateRuleId.Type;
export const AxisOnboardingConflictId = onboardingId("AxisOnboardingConflictId");
export type AxisOnboardingConflictId = typeof AxisOnboardingConflictId.Type;
export const AxisOnboardingDecisionId = onboardingId("AxisOnboardingDecisionId");
export type AxisOnboardingDecisionId = typeof AxisOnboardingDecisionId.Type;

export const AxisOnboardingRunStatus = Schema.Literals([
  "running",
  "cancelled",
  "failed",
  "completed",
]);
export type AxisOnboardingRunStatus = typeof AxisOnboardingRunStatus.Type;

const onboardingSourceFields = {
  id: AxisOnboardingSourceId,
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  kind: Schema.Literals(["manifest", "instruction", "ci", "template", "convention"]),
};

/** A source is either read successfully or failed to read; failure is never absence. */
export const AxisOnboardingSource = Schema.Union([
  Schema.Struct({
    ...onboardingSourceFields,
    status: Schema.Literal("read"),
    error: Schema.Null,
  }),
  Schema.Struct({
    ...onboardingSourceFields,
    status: Schema.Literal("absent"),
    error: Schema.Null,
  }),
  Schema.Struct({
    ...onboardingSourceFields,
    status: Schema.Literal("failed"),
    error: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  }),
]);
export type AxisOnboardingSource = typeof AxisOnboardingSource.Type;

export const AxisOnboardingDigest = Schema.Struct({
  id: AxisOnboardingDigestId,
  sourceId: AxisOnboardingSourceId,
  algorithm: Schema.Literals(["sha256"]),
  value: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  observedAt: IsoDateTime,
});
export type AxisOnboardingDigest = typeof AxisOnboardingDigest.Type;

export const AxisOnboardingFact = Schema.Struct({
  id: AxisOnboardingFactId,
  sourceId: AxisOnboardingSourceId,
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  value: boundedText,
  confidence: Schema.Literals(["explicit", "inferred"]),
});
export type AxisOnboardingFact = typeof AxisOnboardingFact.Type;

export const AxisOnboardingCandidateRule = Schema.Struct({
  id: AxisOnboardingCandidateRuleId,
  category: AxisProjectRuleCategory,
  text: boundedNonEmptyText,
  effect: Schema.Literals(["restriction", "preference", "default"]),
  sourceIds: Schema.Array(AxisOnboardingSourceId).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  factIds: Schema.Array(AxisOnboardingFactId).check(Schema.isMaxLength(100)),
});
export type AxisOnboardingCandidateRule = typeof AxisOnboardingCandidateRule.Type;

export const AxisOnboardingConflict = Schema.Struct({
  id: AxisOnboardingConflictId,
  candidateRuleIds: Schema.Array(AxisOnboardingCandidateRuleId).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(20),
  ),
  description: boundedNonEmptyText,
});
export type AxisOnboardingConflict = typeof AxisOnboardingConflict.Type;

export const AxisOnboardingDecision = Schema.Struct({
  id: AxisOnboardingDecisionId,
  candidateRuleId: AxisOnboardingCandidateRuleId,
  decision: Schema.Literals(["accept", "reject", "defer"]),
  note: Schema.NullOr(TrimmedString.check(Schema.isMaxLength(4_000))),
});
export type AxisOnboardingDecision = typeof AxisOnboardingDecision.Type;

/** The canonical T3 execution records are references, not onboarding replicas. */
export const AxisOnboardingExecution = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  commandId: CommandId,
});
export type AxisOnboardingExecution = typeof AxisOnboardingExecution.Type;

const onboardingRunFields = {
  id: AxisOnboardingRunId,
  scope: AxisContextProjectScope,
  execution: AxisOnboardingExecution,
  sources: Schema.Array(AxisOnboardingSource).check(Schema.isMaxLength(200)),
  digests: Schema.Array(AxisOnboardingDigest).check(Schema.isMaxLength(200)),
  facts: Schema.Array(AxisOnboardingFact).check(Schema.isMaxLength(500)),
  candidateRules: Schema.Array(AxisOnboardingCandidateRule).check(Schema.isMaxLength(500)),
  conflicts: Schema.Array(AxisOnboardingConflict).check(Schema.isMaxLength(200)),
  decisions: Schema.Array(AxisOnboardingDecision).check(Schema.isMaxLength(500)),
  startedAt: IsoDateTime,
};

/** Run lifecycle is explicit: active runs cannot be terminal and terminal runs are finished. */
export const AxisOnboardingRun = Schema.Union([
  Schema.Struct({
    ...onboardingRunFields,
    status: Schema.Literal("running"),
    error: Schema.Null,
    finishedAt: Schema.Null,
  }),
  Schema.Struct({
    ...onboardingRunFields,
    status: Schema.Literal("cancelled"),
    error: Schema.Null,
    finishedAt: IsoDateTime,
  }),
  Schema.Struct({
    ...onboardingRunFields,
    status: Schema.Literal("failed"),
    error: boundedNonEmptyText,
    finishedAt: IsoDateTime,
  }),
  Schema.Struct({
    ...onboardingRunFields,
    status: Schema.Literal("completed"),
    error: Schema.Null,
    finishedAt: IsoDateTime,
  }),
]);
export type AxisOnboardingRun = typeof AxisOnboardingRun.Type;

export const AxisOnboardingStartInput = Schema.Struct({
  run: AxisOnboardingRun,
});
export type AxisOnboardingStartInput = typeof AxisOnboardingStartInput.Type;

/** Client request for a new run; the server derives all observed project data. */
export const AxisOnboardingStartRequest = Schema.Struct({
  scope: AxisContextProjectScope,
  execution: AxisOnboardingExecution,
});
export type AxisOnboardingStartRequest = typeof AxisOnboardingStartRequest.Type;

export const AxisOnboardingListInput = Schema.Struct({
  scope: AxisContextProjectScope,
});
export type AxisOnboardingListInput = typeof AxisOnboardingListInput.Type;

export const AxisOnboardingGetInput = Schema.Struct({
  scope: AxisContextProjectScope,
  runId: AxisOnboardingRunId,
});
export type AxisOnboardingGetInput = typeof AxisOnboardingGetInput.Type;

export const AxisOnboardingCancelInput = Schema.Struct({
  runId: AxisOnboardingRunId,
  commandId: CommandId,
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
});
export type AxisOnboardingCancelInput = typeof AxisOnboardingCancelInput.Type;

export const AxisOnboardingRetryInput = Schema.Struct({
  runId: AxisOnboardingRunId,
  commandId: CommandId,
});
export type AxisOnboardingRetryInput = typeof AxisOnboardingRetryInput.Type;

/** Applying decisions is the only operation that can change the active profile. */
export const AxisOnboardingApplyInput = Schema.Struct({
  scope: AxisContextProjectScope,
  runId: AxisOnboardingRunId,
  expectedProfileRevision: NonNegativeInt,
  decisions: Schema.Array(AxisOnboardingDecision).check(Schema.isMaxLength(500)),
  commandId: CommandId,
});
export type AxisOnboardingApplyInput = typeof AxisOnboardingApplyInput.Type;

export const AxisOnboardingProgressStage = Schema.Literals([
  "collecting",
  "analyzing",
  "ready",
  "cancelling",
  "cancelled",
  "failed",
  "completed",
]);
export type AxisOnboardingProgressStage = typeof AxisOnboardingProgressStage.Type;

export const AxisOnboardingProgress = Schema.Struct({
  stage: AxisOnboardingProgressStage,
  completedSteps: NonNegativeInt,
  totalSteps: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
});
export type AxisOnboardingProgress = typeof AxisOnboardingProgress.Type;

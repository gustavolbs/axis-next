/** Engine-independent boundary for bounded Axis learning runs. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { AxisContextId, AxisProjectLocator, AxisProviderInstanceLocator } from "./axisContext.ts";
import {
  AxisLearningEvidenceId,
  AxisLearningScope,
  AxisLearningProposalKind,
} from "./axisLearning.ts";
import { AxisTypedChange } from "./axisProjectProfile.ts";

export const AXIS_LEARNING_ENGINE_MAX_EVIDENCE_REFS = 32;
export const AXIS_LEARNING_ENGINE_MAX_CANDIDATE_PROPOSALS = 8;
export const AXIS_LEARNING_ENGINE_MAX_CONTENT_LENGTH = 12_000;
export const AXIS_LEARNING_ENGINE_MAX_DEADLINE_MS = 120_000;

const boundedEvidenceIds = Schema.Array(AxisLearningEvidenceId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(AXIS_LEARNING_ENGINE_MAX_EVIDENCE_REFS),
);

/** A reference carries enough scope for the server to reject cross-context batches. */
export const AxisLearningEngineEvidenceRef = Schema.Struct({
  id: AxisLearningEvidenceId,
  contextId: AxisContextId,
  scope: Schema.optionalKey(AxisLearningScope),
});
export type AxisLearningEngineEvidenceRef = typeof AxisLearningEngineEvidenceRef.Type;

/** Deliberately summary-only input; raw sessions, tools, and credentials are not part of it. */
export const AxisLearningEngineContent = TrimmedNonEmptyString.check(
  Schema.isMaxLength(AXIS_LEARNING_ENGINE_MAX_CONTENT_LENGTH),
);
export type AxisLearningEngineContent = typeof AxisLearningEngineContent.Type;

const sameProject = (
  left: AxisProjectLocator | undefined,
  right: AxisProjectLocator | undefined,
) =>
  left === undefined && right === undefined
    ? true
    : left !== undefined &&
      right !== undefined &&
      left.environmentId === right.environmentId &&
      left.projectId === right.projectId;

const sameScope = (left: AxisLearningScope | undefined, right: AxisLearningScope | undefined) =>
  (left === undefined && right === undefined) ||
  (left !== undefined &&
    right !== undefined &&
    left.contextId === right.contextId &&
    sameProject(left.project, right.project));

/** The only input an engine receives for one bounded analysis run. */
export const AxisLearningEngineRequest = Schema.Struct({
  contextId: AxisContextId,
  scope: Schema.optionalKey(AxisLearningScope),
  evidenceRefs: Schema.Array(AxisLearningEngineEvidenceRef).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(AXIS_LEARNING_ENGINE_MAX_EVIDENCE_REFS),
  ),
  content: AxisLearningEngineContent,
  deadlineMs: PositiveInt.check(Schema.isLessThanOrEqualTo(AXIS_LEARNING_ENGINE_MAX_DEADLINE_MS)),
}).check(
  Schema.makeFilter(
    (value) =>
      ((value.scope === undefined || value.scope.contextId === value.contextId) &&
        new Set(value.evidenceRefs.map((reference) => reference.id)).size ===
          value.evidenceRefs.length &&
        value.evidenceRefs.every(
          (reference) =>
            reference.contextId === value.contextId && sameScope(reference.scope, value.scope),
        )) ||
      "Evidence references must be unique and belong to the requested context and scope.",
  ),
);
export type AxisLearningEngineRequest = typeof AxisLearningEngineRequest.Type;

/** Candidate changes are typed, but are not active configuration or persisted proposals. */
export const AxisLearningEngineCandidateProposal = Schema.Struct({
  contextId: AxisContextId,
  scope: Schema.optionalKey(AxisLearningScope),
  kind: AxisLearningProposalKind,
  targetKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  targetProvider: Schema.optionalKey(AxisProviderInstanceLocator),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  rationale: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  evidenceIds: boundedEvidenceIds,
  change: AxisTypedChange,
}).check(
  Schema.makeFilter((value) =>
    value.scope === undefined || value.scope.contextId === value.contextId
      ? true
      : "Candidate proposal scope must match its contextId.",
  ),
);
export type AxisLearningEngineCandidateProposal = typeof AxisLearningEngineCandidateProposal.Type;

export const AxisLearningEngineNoChange = Schema.Struct({
  status: Schema.Literal("no-change"),
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
});
export type AxisLearningEngineNoChange = typeof AxisLearningEngineNoChange.Type;

/** Untrusted engine output is decoded before it can be returned to any caller. */
export const AxisLearningEngineOutput = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("proposals"),
    proposals: Schema.Array(AxisLearningEngineCandidateProposal).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(AXIS_LEARNING_ENGINE_MAX_CANDIDATE_PROPOSALS),
    ),
  }),
  AxisLearningEngineNoChange,
]);
export type AxisLearningEngineOutput = typeof AxisLearningEngineOutput.Type;

export const AxisLearningEngineAvailability = Schema.Literals(["available", "absent", "offline"]);
export type AxisLearningEngineAvailability = typeof AxisLearningEngineAvailability.Type;

export const AxisLearningEngineStatus = Schema.Struct({
  availability: AxisLearningEngineAvailability,
  message: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
  engineId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type AxisLearningEngineStatus = typeof AxisLearningEngineStatus.Type;

/** Absence is a normal, observable state and is not reported as a failed run. */
export const AxisLearningEngineUnavailable = Schema.Struct({
  status: Schema.Literal("unavailable"),
  availability: Schema.Literals(["absent", "offline"]),
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
});
export type AxisLearningEngineUnavailable = typeof AxisLearningEngineUnavailable.Type;

export const AxisLearningEngineRunResult = Schema.Union([
  AxisLearningEngineOutput,
  AxisLearningEngineUnavailable,
]);
export type AxisLearningEngineRunResult = typeof AxisLearningEngineRunResult.Type;

export class AxisLearningEngineValidationError extends Schema.TaggedErrorClass<AxisLearningEngineValidationError>()(
  "AxisLearningEngineValidationError",
  { message: Schema.String },
) {}

export class AxisLearningEngineOutputError extends Schema.TaggedErrorClass<AxisLearningEngineOutputError>()(
  "AxisLearningEngineOutputError",
  { message: Schema.String },
) {}

export class AxisLearningEngineDeadlineExceededError extends Schema.TaggedErrorClass<AxisLearningEngineDeadlineExceededError>()(
  "AxisLearningEngineDeadlineExceededError",
  { deadlineMs: PositiveInt },
) {}

export class AxisLearningEngineCancelledError extends Schema.TaggedErrorClass<AxisLearningEngineCancelledError>()(
  "AxisLearningEngineCancelledError",
  { message: Schema.String },
) {}

export class AxisLearningEngineExecutionError extends Schema.TaggedErrorClass<AxisLearningEngineExecutionError>()(
  "AxisLearningEngineExecutionError",
  { message: Schema.String },
) {}

export const AxisLearningEngineError = Schema.Union([
  AxisLearningEngineValidationError,
  AxisLearningEngineOutputError,
  AxisLearningEngineDeadlineExceededError,
  AxisLearningEngineCancelledError,
  AxisLearningEngineExecutionError,
]);
export type AxisLearningEngineError = typeof AxisLearningEngineError.Type;

export function axisLearningEngineScopeEquals(
  left: AxisLearningScope | undefined,
  right: AxisLearningScope | undefined,
): boolean {
  return sameScope(left, right);
}

/** Cancellation is supplied by Effect interruption or the optional signal at the server boundary. */
export interface AxisLearningEngineCancellation {
  readonly signal?: AbortSignal | undefined;
}

export type AxisLearningEngineHandler = (
  request: AxisLearningEngineRequest,
  cancellation: AxisLearningEngineCancellation,
) => Effect.Effect<unknown, AxisLearningEngineExecutionError>;

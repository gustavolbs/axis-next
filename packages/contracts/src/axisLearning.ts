/** Engine-independent contracts for the Axis Learning Layer. */
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { AxisContextId, AxisProviderInstanceLocator } from "./axisContext.ts";

const ENTITY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const learningId = <B extends string>(brand: B) =>
  TrimmedNonEmptyString.check(Schema.isMaxLength(128), Schema.isPattern(ENTITY_ID_PATTERN)).pipe(
    Schema.brand(brand),
  );

export const AxisLearningEvidenceId = learningId("AxisLearningEvidenceId");
export type AxisLearningEvidenceId = typeof AxisLearningEvidenceId.Type;
export const AxisLearningProposalId = learningId("AxisLearningProposalId");
export type AxisLearningProposalId = typeof AxisLearningProposalId.Type;
export const AxisLearningVersionId = learningId("AxisLearningVersionId");
export type AxisLearningVersionId = typeof AxisLearningVersionId.Type;
export const AxisLearningLifecycleEventId = learningId("AxisLearningLifecycleEventId");
export type AxisLearningLifecycleEventId = typeof AxisLearningLifecycleEventId.Type;

export const AxisLearningProvenance = Schema.Struct({
  contextId: AxisContextId,
  sourceKind: Schema.Literals([
    "thread-turn",
    "user-correction",
    "work-hub",
    "scheduled-activity",
    "evaluation",
  ]),
  sourceId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  provider: Schema.optionalKey(AxisProviderInstanceLocator),
  observedAt: IsoDateTime,
  cursor: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  /** Stable digest used to deduplicate reprocessing without retaining raw input. */
  fingerprint: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type AxisLearningProvenance = typeof AxisLearningProvenance.Type;

export const AxisLearningEvidence = Schema.Struct({
  id: AxisLearningEvidenceId,
  provenance: AxisLearningProvenance,
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  createdAt: IsoDateTime,
  /** Evidence may be purged after this point; proposals keep its stable id. */
  expiresAt: IsoDateTime,
});
export type AxisLearningEvidence = typeof AxisLearningEvidence.Type;

export const AxisLearningProposalKind = Schema.Literals([
  "provider-skill",
  "provider-instructions",
  "work-hub-policy",
  "scheduled-activity",
  "workflow-recommendation",
]);
export type AxisLearningProposalKind = typeof AxisLearningProposalKind.Type;

export const AxisLearningProposalStatus = Schema.Literals([
  "draft",
  "in-review",
  "approved",
  "rejected",
]);
export type AxisLearningProposalStatus = typeof AxisLearningProposalStatus.Type;

const proposalFields = {
  contextId: AxisContextId,
  kind: AxisLearningProposalKind,
  targetKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  targetProvider: Schema.optionalKey(AxisProviderInstanceLocator),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  rationale: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  evidenceIds: Schema.Array(AxisLearningEvidenceId).check(Schema.isMinLength(1)),
  change: Schema.Unknown,
} as const;

export const AxisLearningProposalDraft = Schema.Struct({
  id: AxisLearningProposalId,
  ...proposalFields,
});
export type AxisLearningProposalDraft = typeof AxisLearningProposalDraft.Type;

export const AxisLearningProposal = Schema.Struct({
  id: AxisLearningProposalId,
  ...proposalFields,
  status: AxisLearningProposalStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  reviewedAt: Schema.NullOr(IsoDateTime),
  reviewedBy: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  reviewNote: Schema.NullOr(Schema.String),
});
export type AxisLearningProposal = typeof AxisLearningProposal.Type;

/** Immutable snapshot created only by explicit approval. */
export const AxisLearningVersion = Schema.Struct({
  id: AxisLearningVersionId,
  proposalId: AxisLearningProposalId,
  ...proposalFields,
  approvedBy: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  createdAt: IsoDateTime,
});
export type AxisLearningVersion = typeof AxisLearningVersion.Type;

export const AxisLearningLifecycleEvent = Schema.Struct({
  id: AxisLearningLifecycleEventId,
  contextId: AxisContextId,
  action: Schema.Literals(["submitted", "approved", "rejected", "activated", "rolled-back"]),
  proposalId: Schema.NullOr(AxisLearningProposalId),
  versionId: Schema.NullOr(AxisLearningVersionId),
  previousVersionId: Schema.NullOr(AxisLearningVersionId),
  actor: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  note: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type AxisLearningLifecycleEvent = typeof AxisLearningLifecycleEvent.Type;

export const AxisLearningActiveVersion = Schema.Struct({
  contextId: AxisContextId,
  targetKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  versionId: AxisLearningVersionId,
  activatedAt: IsoDateTime,
});
export type AxisLearningActiveVersion = typeof AxisLearningActiveVersion.Type;

export const AxisLearningSnapshot = Schema.Struct({
  contextId: AxisContextId,
  evidence: Schema.Array(AxisLearningEvidence),
  proposals: Schema.Array(AxisLearningProposal),
  versions: Schema.Array(AxisLearningVersion),
  activeVersions: Schema.Array(AxisLearningActiveVersion),
  lifecycle: Schema.Array(AxisLearningLifecycleEvent),
});
export type AxisLearningSnapshot = typeof AxisLearningSnapshot.Type;

export const AxisLearningListInput = Schema.Struct({ contextId: AxisContextId });
export const AxisLearningRecordEvidenceInput = Schema.Struct({ evidence: AxisLearningEvidence });
export const AxisLearningCreateProposalInput = Schema.Struct({
  proposal: AxisLearningProposalDraft,
});
export const AxisLearningProposalActionInput = Schema.Struct({ id: AxisLearningProposalId });
export const AxisLearningReviewProposalInput = Schema.Struct({
  id: AxisLearningProposalId,
  note: Schema.optionalKey(Schema.String),
});
export const AxisLearningVersionActionInput = Schema.Struct({ id: AxisLearningVersionId });

export class AxisLearningNotFoundError extends Schema.TaggedErrorClass<AxisLearningNotFoundError>()(
  "AxisLearningNotFoundError",
  { entity: Schema.String, id: Schema.String },
) {}

export class AxisLearningConflictError extends Schema.TaggedErrorClass<AxisLearningConflictError>()(
  "AxisLearningConflictError",
  { entity: Schema.String, id: Schema.String },
) {}

export class AxisLearningTransitionError extends Schema.TaggedErrorClass<AxisLearningTransitionError>()(
  "AxisLearningTransitionError",
  { proposalId: AxisLearningProposalId, status: AxisLearningProposalStatus, action: Schema.String },
) {}

export class AxisLearningValidationError extends Schema.TaggedErrorClass<AxisLearningValidationError>()(
  "AxisLearningValidationError",
  { message: Schema.String },
) {}

export class AxisLearningPersistenceError extends Schema.TaggedErrorClass<AxisLearningPersistenceError>()(
  "AxisLearningPersistenceError",
  { operation: Schema.String },
) {}

export const AxisLearningStoreError = Schema.Union([
  AxisLearningNotFoundError,
  AxisLearningConflictError,
  AxisLearningTransitionError,
  AxisLearningValidationError,
  AxisLearningPersistenceError,
]);
export type AxisLearningStoreError = typeof AxisLearningStoreError.Type;

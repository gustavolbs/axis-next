/** Engine-independent contracts for the Axis Learning Layer. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { CommandId, IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { AxisContextId, AxisProjectLocator, AxisProviderInstanceLocator } from "./axisContext.ts";
import { AxisTypedChange } from "./axisProjectProfile.ts";

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

/** Optional project qualification; omission is the preserved context-only legacy scope. */
export const AxisLearningScope = Schema.Struct({
  contextId: AxisContextId,
  project: Schema.optionalKey(AxisProjectLocator),
});
export type AxisLearningScope = typeof AxisLearningScope.Type;

export const AxisLearningLegacyChange = Schema.Struct({
  kind: Schema.Literal("legacy-unknown"),
  value: Schema.Unknown,
});
export type AxisLearningLegacyChange = typeof AxisLearningLegacyChange.Type;

/**
 * New proposals can execute only typed changes. Unknown changes are wrapped so
 * old records remain viewable without making their payload executable.
 */
const AxisLearningStoredChange = Schema.Union([AxisTypedChange, AxisLearningLegacyChange]);
type AxisLearningStoredChange = typeof AxisLearningStoredChange.Type;
const isAxisTypedChange = Schema.is(AxisTypedChange);

export const AxisLearningChange = Schema.Unknown.pipe(
  Schema.decodeTo(
    AxisLearningStoredChange,
    SchemaTransformation.transform<typeof AxisLearningStoredChange.Encoded, unknown>({
      decode: (value) =>
        isAxisTypedChange(value)
          ? (value as AxisLearningStoredChange)
          : ({ kind: "legacy-unknown", value } as AxisLearningStoredChange),
      encode: (value) => {
        const change = value as AxisLearningStoredChange;
        return "kind" in change && change.kind === "legacy-unknown" ? change.value : change;
      },
    }),
  ),
);
export type AxisLearningChange = typeof AxisLearningChange.Type;

export const AxisLearningProvenance = Schema.Struct({
  contextId: AxisContextId,
  scope: Schema.optionalKey(AxisLearningScope),
  sourceKind: Schema.Literals([
    "thread-turn",
    "user-correction",
    "work-hub",
    "scheduled-activity",
    "evaluation",
    "review",
    "ticket",
    "skill",
    "workspace-change",
  ]),
  sourceId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  provider: Schema.optionalKey(AxisProviderInstanceLocator),
  observedAt: IsoDateTime,
  cursor: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  /** Stable digest used to deduplicate reprocessing without retaining raw input. */
  fingerprint: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
}).check(
  Schema.makeFilter((value) =>
    value.scope === undefined || value.scope.contextId === value.contextId
      ? true
      : "Learning provenance scope contextId must match provenance contextId.",
  ),
);
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
  scope: Schema.optionalKey(AxisLearningScope),
  kind: AxisLearningProposalKind,
  targetKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  targetProvider: Schema.optionalKey(AxisProviderInstanceLocator),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  rationale: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  evidenceIds: Schema.Array(AxisLearningEvidenceId).check(Schema.isMinLength(1)),
  change: AxisLearningChange,
} as const;

export const AxisLearningProposalDraft = Schema.Struct({
  id: AxisLearningProposalId,
  ...proposalFields,
}).check(
  Schema.makeFilter((value) =>
    value.scope === undefined || value.scope.contextId === value.contextId
      ? true
      : "Learning scope contextId must match the proposal contextId.",
  ),
);
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
}).check(
  Schema.makeFilter((value) =>
    value.scope === undefined || value.scope.contextId === value.contextId
      ? true
      : "Learning scope contextId must match the proposal contextId.",
  ),
);
export type AxisLearningProposal = typeof AxisLearningProposal.Type;

/** Immutable snapshot created only by explicit approval. */
export const AxisLearningVersion = Schema.Struct({
  id: AxisLearningVersionId,
  proposalId: AxisLearningProposalId,
  ...proposalFields,
  approvedBy: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  createdAt: IsoDateTime,
}).check(
  Schema.makeFilter((value) =>
    value.scope === undefined || value.scope.contextId === value.contextId
      ? true
      : "Learning scope contextId must match the version contextId.",
  ),
);
export type AxisLearningVersion = typeof AxisLearningVersion.Type;

export const AxisLearningLifecycleEvent = Schema.Struct({
  id: AxisLearningLifecycleEventId,
  contextId: AxisContextId,
  scope: Schema.optionalKey(AxisLearningScope),
  action: Schema.Literals([
    "submitted",
    "approved",
    "rejected",
    "activated",
    "rolled-back",
    "deactivated",
  ]),
  proposalId: Schema.NullOr(AxisLearningProposalId),
  versionId: Schema.NullOr(AxisLearningVersionId),
  previousVersionId: Schema.NullOr(AxisLearningVersionId),
  actor: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  note: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  commandId: Schema.optionalKey(CommandId),
  requestDigest: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  resultingRevision: Schema.optionalKey(NonNegativeInt),
}).check(
  Schema.makeFilter((value) =>
    value.scope === undefined || value.scope.contextId === value.contextId
      ? true
      : "Learning scope contextId must match the lifecycle contextId.",
  ),
);
export type AxisLearningLifecycleEvent = typeof AxisLearningLifecycleEvent.Type;

export const AxisLearningActiveVersion = Schema.Struct({
  contextId: AxisContextId,
  scope: Schema.optionalKey(AxisLearningScope),
  targetKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  versionId: AxisLearningVersionId,
  activatedAt: IsoDateTime,
}).check(
  Schema.makeFilter((value) =>
    value.scope === undefined || value.scope.contextId === value.contextId
      ? true
      : "Learning scope contextId must match the active version contextId.",
  ),
);
export type AxisLearningActiveVersion = typeof AxisLearningActiveVersion.Type;

/** Includes an explicit null state so deactivation remains observable. */
export const AxisLearningActivationState = Schema.Struct({
  scope: AxisLearningScope,
  targetKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  versionId: Schema.NullOr(AxisLearningVersionId),
  revision: NonNegativeInt,
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type AxisLearningActivationState = typeof AxisLearningActivationState.Type;

export const AxisLearningActivationResponse = Schema.Struct({
  activeState: AxisLearningActivationState,
  lifecycleEvent: Schema.NullOr(AxisLearningLifecycleEvent),
});
export type AxisLearningActivationResponse = typeof AxisLearningActivationResponse.Type;

export const AxisLearningSnapshot = Schema.Struct({
  contextId: AxisContextId,
  evidence: Schema.Array(AxisLearningEvidence),
  proposals: Schema.Array(AxisLearningProposal),
  versions: Schema.Array(AxisLearningVersion),
  activeVersions: Schema.Array(AxisLearningActiveVersion),
  activeStates: Schema.Array(AxisLearningActivationState).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  lifecycle: Schema.Array(AxisLearningLifecycleEvent),
});
export type AxisLearningSnapshot = typeof AxisLearningSnapshot.Type;

const AxisLearningScopedInputSource = Schema.Struct({
  contextId: Schema.optionalKey(AxisContextId),
  scope: Schema.optionalKey(AxisLearningScope),
});

const AxisLearningScopedInput = Schema.Struct({
  contextId: AxisContextId,
  scope: Schema.optionalKey(AxisLearningScope),
});

const decodeScopedInput = (raw: typeof AxisLearningScopedInputSource.Type) => ({
  contextId: raw.contextId ?? raw.scope?.contextId ?? "",
  ...(raw.scope === undefined ? {} : { scope: raw.scope }),
});

export const AxisLearningListInput = AxisLearningScopedInputSource.pipe(
  Schema.decodeTo(
    AxisLearningScopedInput,
    SchemaTransformation.transform<
      typeof AxisLearningScopedInput.Encoded,
      typeof AxisLearningScopedInputSource.Type
    >({
      decode: (raw) => decodeScopedInput(raw) as typeof AxisLearningScopedInput.Encoded,
      encode: (value) => value as typeof AxisLearningScopedInputSource.Type,
    }),
  ),
);
export const AxisLearningRecordEvidenceInput = Schema.Struct({
  evidence: AxisLearningEvidence,
  scope: Schema.optionalKey(AxisLearningScope),
});
export const AxisLearningCreateProposalInput = Schema.Struct({
  proposal: AxisLearningProposalDraft,
  scope: Schema.optionalKey(AxisLearningScope),
});
export const AxisLearningProposalActionInput = Schema.Struct({
  id: AxisLearningProposalId,
  scope: Schema.optionalKey(AxisLearningScope),
});
export const AxisLearningReviewProposalInput = Schema.Struct({
  id: AxisLearningProposalId,
  note: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(AxisLearningScope),
});
const AxisLearningVersionActionInputSource = Schema.Struct({
  id: Schema.optionalKey(AxisLearningVersionId),
  scope: Schema.optionalKey(AxisLearningScope),
  targetKey: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  versionId: Schema.optionalKey(AxisLearningVersionId),
  expectedRevision: Schema.optionalKey(NonNegativeInt),
  commandId: Schema.optionalKey(CommandId),
});
const AxisLearningVersionActionInputWire = Schema.Struct({
  id: AxisLearningVersionId,
  scope: Schema.optionalKey(AxisLearningScope),
  targetKey: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  versionId: Schema.optionalKey(AxisLearningVersionId),
  expectedRevision: Schema.optionalKey(NonNegativeInt),
  commandId: Schema.optionalKey(CommandId),
});
export const AxisLearningVersionActionInput = AxisLearningVersionActionInputSource.pipe(
  Schema.decodeTo(
    AxisLearningVersionActionInputWire,
    SchemaTransformation.transform<
      typeof AxisLearningVersionActionInputWire.Encoded,
      typeof AxisLearningVersionActionInputSource.Type
    >({
      decode: (raw) =>
        ({
          ...raw,
          id: raw.id ?? raw.versionId ?? "",
          ...(raw.versionId === undefined && raw.id !== undefined ? { versionId: raw.id } : {}),
        }) as typeof AxisLearningVersionActionInputWire.Encoded,
      encode: (value) => value as typeof AxisLearningVersionActionInputSource.Type,
    }),
  ),
);
export const AxisLearningDeactivateInput = Schema.Struct({
  scope: AxisLearningScope,
  targetKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  expectedRevision: NonNegativeInt,
  commandId: CommandId,
  note: Schema.optionalKey(Schema.String),
});
export type AxisLearningDeactivateInput = typeof AxisLearningDeactivateInput.Type;

export class AxisLearningRevisionRequiredError extends Schema.TaggedErrorClass<AxisLearningRevisionRequiredError>()(
  "AxisLearningRevisionRequiredError",
  { message: Schema.String },
) {}

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
  AxisLearningRevisionRequiredError,
]);
export type AxisLearningStoreError = typeof AxisLearningStoreError.Type;

export function emptyAxisLearningActivationState(
  scope: AxisLearningScope,
  targetKey: string,
): AxisLearningActivationState {
  return { scope, targetKey, versionId: null, revision: 0, updatedAt: null };
}

export function normalizeAxisLearningActivationState(
  state: AxisLearningActivationState | undefined,
  scope: AxisLearningScope,
  targetKey: string,
): AxisLearningActivationState {
  return state ?? emptyAxisLearningActivationState(scope, targetKey);
}

function providerKey(provider: AxisProviderInstanceLocator | undefined): string | null {
  return provider === undefined ? null : `${provider.environmentId}\u0000${provider.instanceId}`;
}

/** Semantic identity used by the store when a retry supplies fresh ids/timestamps. */
export function axisLearningEvidenceSemanticallyEquals(
  left: AxisLearningEvidence,
  right: AxisLearningEvidence,
): boolean {
  return (
    left.provenance.contextId === right.provenance.contextId &&
    left.provenance.scope?.project?.environmentId ===
      right.provenance.scope?.project?.environmentId &&
    left.provenance.scope?.project?.projectId === right.provenance.scope?.project?.projectId &&
    left.provenance.fingerprint === right.provenance.fingerprint &&
    left.provenance.sourceKind === right.provenance.sourceKind &&
    left.provenance.sourceId === right.provenance.sourceId &&
    left.provenance.cursor === right.provenance.cursor &&
    left.provenance.observedAt === right.provenance.observedAt &&
    providerKey(left.provenance.provider) === providerKey(right.provenance.provider) &&
    left.summary === right.summary
  );
}

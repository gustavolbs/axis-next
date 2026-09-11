import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  axisContextProjectScopeKey,
  type AxisContextProjectScope,
  type AxisLearningActiveVersion,
  type AxisLearningActivationState,
  type AxisLearningEvidence,
  type AxisLearningLifecycleEvent,
  type AxisLearningProposal,
  type AxisLearningSnapshot,
  type AxisLearningVersion,
  type AxisProjectProfile,
  type AxisTaskExtension,
} from "@t3tools/contracts";

export type AxisProjectDataLifecycleAction = "export" | "purge" | "delete" | "promote";
export type AxisProjectDataLifecycleAllowedAction = Exclude<
  AxisProjectDataLifecycleAction,
  "promote"
>;

export type AxisProjectDataLifecyclePromotion = Readonly<{
  readonly status: "unavailable";
  readonly reason: string;
}>;

/**
 * Policy is scoped to one physical project/context tuple. Promotion is kept
 * out of the allowed actions until a future flow can make the copy explicit.
 */
export type AxisProjectDataLifecyclePolicy = Readonly<{
  readonly scope: AxisContextProjectScope;
  readonly allowedActions: ReadonlyArray<AxisProjectDataLifecycleAllowedAction>;
  readonly promotion: AxisProjectDataLifecyclePromotion;
}>;

export type AxisProjectDataLifecycleAuthorizationRequest = Readonly<{
  readonly action: AxisProjectDataLifecycleAction;
  readonly scope: AxisContextProjectScope;
  readonly policy?: AxisProjectDataLifecyclePolicy;
}>;

export type AxisProjectDataLifecycleAuthorization = Readonly<{
  readonly action: AxisProjectDataLifecycleAllowedAction;
  readonly scope: AxisContextProjectScope;
}>;

export class AxisProjectDataLifecycleAuthorizationError extends Error {
  readonly _tag = "AxisProjectDataLifecycleAuthorizationError" as const;
  readonly reason: "scope_mismatch" | "action_not_allowed" | "promotion_unavailable";
  readonly action: AxisProjectDataLifecycleAction;
  readonly scope: AxisContextProjectScope;

  constructor(
    reason: "scope_mismatch" | "action_not_allowed" | "promotion_unavailable",
    action: AxisProjectDataLifecycleAction,
    scope: AxisContextProjectScope,
    message: string,
  ) {
    super(message);
    this.name = "AxisProjectDataLifecycleAuthorizationError";
    this.reason = reason;
    this.action = action;
    this.scope = scope;
  }
}

export class AxisProjectDataLifecycleValidationError extends Error {
  readonly _tag = "AxisProjectDataLifecycleValidationError" as const;
  override readonly message: string;

  constructor(message: string) {
    super(message);
    this.name = "AxisProjectDataLifecycleValidationError";
    this.message = message;
  }
}

export type AxisProjectDataLifecycleTaskCommand = Readonly<{
  readonly contextId: string;
  readonly scope: AxisContextProjectScope;
  readonly threadId: string;
  readonly commandId: string;
  readonly taskId: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}>;

export type AxisProjectDataLifecycleTaskLifecycleEvent = Readonly<{
  readonly id: string | number;
  readonly contextId: string;
  readonly scope: AxisContextProjectScope;
  readonly threadId: string;
  readonly taskId: string;
  readonly action: "created" | "updated" | "paused" | "reopened" | "source-unlinked";
  readonly event: unknown;
  readonly createdAt: string;
}>;

/** The rows owned by a project that X13 can plan against without persistence. */
export type AxisProjectDataLifecycleDataset = Readonly<{
  readonly profile?: AxisProjectProfile | null;
  readonly learning: AxisLearningSnapshot;
  readonly tasks?: ReadonlyArray<AxisTaskExtension>;
  readonly taskCommands?: ReadonlyArray<AxisProjectDataLifecycleTaskCommand>;
  readonly taskLifecycle?: ReadonlyArray<AxisProjectDataLifecycleTaskLifecycleEvent>;
}>;

export type AxisProjectDataLifecycleEvidenceExport =
  | Readonly<{
      readonly id: AxisLearningEvidence["id"];
      readonly availability: "available";
      readonly evidence: AxisLearningEvidence;
    }>
  | Readonly<{
      readonly id: AxisLearningEvidence["id"];
      readonly availability: "unavailable";
      readonly expiresAt: string | null;
      readonly reason: "expired" | "purged";
    }>;

export type AxisProjectDataLifecycleEvidenceReference = Readonly<{
  readonly evidenceId: AxisLearningEvidence["id"];
  readonly availability: "available" | "unavailable";
  readonly reason?: "expired" | "purged";
}>;

export type AxisProjectDataLifecycleExport = Readonly<{
  readonly scope: AxisContextProjectScope;
  readonly exportedAt: string;
  readonly profile: AxisProjectProfile | null;
  readonly learning: Readonly<{
    readonly evidence: ReadonlyArray<AxisProjectDataLifecycleEvidenceExport>;
    readonly evidenceReferences: ReadonlyArray<AxisProjectDataLifecycleEvidenceReference>;
    readonly proposals: ReadonlyArray<AxisLearningProposal>;
    readonly versions: ReadonlyArray<AxisLearningVersion>;
    readonly activeVersions: ReadonlyArray<AxisLearningActiveVersion>;
    readonly activeStates: ReadonlyArray<AxisLearningActivationState>;
    readonly lifecycle: ReadonlyArray<AxisLearningLifecycleEvent>;
  }>;
  readonly tasks: ReadonlyArray<AxisTaskExtension>;
  readonly taskCommands: ReadonlyArray<AxisProjectDataLifecycleTaskCommand>;
  readonly taskLifecycle: ReadonlyArray<AxisProjectDataLifecycleTaskLifecycleEvent>;
}>;

export type AxisProjectDataLifecyclePurgePlan = Readonly<{
  readonly scope: AxisContextProjectScope;
  readonly now: string;
  readonly evidenceIds: ReadonlyArray<AxisLearningEvidence["id"]>;
  /** Proposals retain these ids even after the evidence row is purged. */
  readonly retainedEvidenceReferences: ReadonlyArray<AxisProjectDataLifecycleEvidenceReference>;
}>;

export type AxisProjectDataLifecycleDeletePlan = Readonly<{
  readonly scope: AxisContextProjectScope;
  readonly mutable: Readonly<{
    readonly deleteProfile: boolean;
    readonly evidenceIds: ReadonlyArray<AxisLearningEvidence["id"]>;
    readonly proposalIds: ReadonlyArray<AxisLearningProposal["id"]>;
    readonly activeVersionTargets: ReadonlyArray<string>;
    readonly taskIds: ReadonlyArray<AxisTaskExtension["id"]>;
    readonly taskCommandIds: ReadonlyArray<string>;
    readonly taskLifecycleIds: ReadonlyArray<string | number>;
  }>;
  readonly retained: Readonly<{
    /** Required by the immutable version -> proposal foreign key. */
    readonly proposalIds: ReadonlyArray<AxisLearningProposal["id"]>;
    readonly versionIds: ReadonlyArray<AxisLearningVersion["id"]>;
    readonly lifecycleIds: ReadonlyArray<AxisLearningLifecycleEvent["id"]>;
    readonly reason: string;
  }>;
}>;

export type AxisProjectDataLifecycleError =
  | AxisProjectDataLifecycleAuthorizationError
  | AxisProjectDataLifecycleValidationError;

const defaultAllowedActions: ReadonlyArray<AxisProjectDataLifecycleAllowedAction> = Object.freeze([
  "export",
  "purge",
  "delete",
]);

const promotionUnavailable: AxisProjectDataLifecyclePromotion = Object.freeze({
  status: "unavailable",
  reason: "Cross-context promotion is unavailable until an explicit copy workflow exists.",
});

const freezeDeep = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
    return Object.freeze(value);
  }
  for (const item of Object.values(value as Record<string, unknown>)) freezeDeep(item);
  return Object.freeze(value);
};

const cloneDeep = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cloneDeep(item)) as T;
  const clone: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    clone[key] = cloneDeep(item);
  }
  return clone as T;
};

const cloneAndFreeze = <T>(value: T): T => freezeDeep(cloneDeep(value));

const sameScope = (left: AxisContextProjectScope, right: AxisContextProjectScope) =>
  axisContextProjectScopeKey(left) === axisContextProjectScopeKey(right);

const scoped = (
  candidate:
    | Readonly<{
        readonly contextId: AxisContextProjectScope["contextId"];
        readonly project?: AxisContextProjectScope["project"];
      }>
    | undefined,
  scope: AxisContextProjectScope,
) =>
  candidate?.project !== undefined &&
  sameScope({ contextId: candidate.contextId, project: candidate.project }, scope);

const evidenceScope = (evidence: AxisLearningEvidence) => evidence.provenance.scope;

const projectEvidence = (evidence: AxisLearningEvidence, scope: AxisContextProjectScope) =>
  scoped(evidenceScope(evidence), scope);

const projectLearningRecord = (
  record: {
    readonly contextId: AxisContextProjectScope["contextId"];
    readonly scope?: Readonly<{
      readonly contextId: AxisContextProjectScope["contextId"];
      readonly project?: AxisContextProjectScope["project"];
    }>;
  },
  scope: AxisContextProjectScope,
) => record.contextId === scope.contextId && scoped(record.scope, scope);

const projectActiveState = (record: AxisLearningActivationState, scope: AxisContextProjectScope) =>
  scoped(record.scope, scope);

const projectTask = (task: AxisTaskExtension, scope: AxisContextProjectScope) =>
  scoped(task.scope, scope);

const projectTaskCommand = (
  command: AxisProjectDataLifecycleTaskCommand,
  scope: AxisContextProjectScope,
) => command.contextId === scope.contextId && scoped(command.scope, scope);

const projectTaskLifecycle = (
  event: AxisProjectDataLifecycleTaskLifecycleEvent,
  scope: AxisContextProjectScope,
) => event.contextId === scope.contextId && scoped(event.scope, scope);

const validateLearningSnapshot = (
  snapshot: AxisLearningSnapshot,
  scope: AxisContextProjectScope,
) =>
  snapshot.contextId === scope.contextId
    ? undefined
    : new AxisProjectDataLifecycleValidationError(
        "Learning snapshot belongs to another Axis context.",
      );

const validateNow = (now: string) => {
  if (Number.isNaN(Date.parse(now))) {
    return new AxisProjectDataLifecycleValidationError("Lifecycle timestamps must be ISO dates.");
  }
  return undefined;
};

export const axisProjectDataLifecyclePolicy = (
  scope: AxisContextProjectScope,
  allowedActions: ReadonlyArray<AxisProjectDataLifecycleAllowedAction> = defaultAllowedActions,
): AxisProjectDataLifecyclePolicy =>
  cloneAndFreeze({
    scope,
    allowedActions: [...new Set(allowedActions)],
    promotion: promotionUnavailable,
  });

const defaultPolicy = (scope: AxisContextProjectScope) => axisProjectDataLifecyclePolicy(scope);

export const authorizeAxisProjectDataLifecycleAction = (
  request: AxisProjectDataLifecycleAuthorizationRequest,
): Effect.Effect<
  AxisProjectDataLifecycleAuthorization,
  AxisProjectDataLifecycleAuthorizationError
> => {
  const policy = request.policy ?? defaultPolicy(request.scope);
  if (!sameScope(policy.scope, request.scope)) {
    return Effect.fail(
      new AxisProjectDataLifecycleAuthorizationError(
        "scope_mismatch",
        request.action,
        request.scope,
        "The lifecycle policy does not authorize this exact project scope.",
      ),
    );
  }
  if (request.action === "promote") {
    return Effect.fail(
      new AxisProjectDataLifecycleAuthorizationError(
        "promotion_unavailable",
        request.action,
        request.scope,
        policy.promotion.reason,
      ),
    );
  }
  if (!policy.allowedActions.includes(request.action)) {
    return Effect.fail(
      new AxisProjectDataLifecycleAuthorizationError(
        "action_not_allowed",
        request.action,
        request.scope,
        `The ${request.action} action is not allowed by this project policy.`,
      ),
    );
  }
  return Effect.succeed(cloneAndFreeze({ action: request.action, scope: request.scope }));
};

const requireAuthorization = (
  authorization: AxisProjectDataLifecycleAuthorization,
  action: AxisProjectDataLifecycleAllowedAction,
): Effect.Effect<void, AxisProjectDataLifecycleAuthorizationError> =>
  authorization.action === action
    ? Effect.void
    : Effect.fail(
        new AxisProjectDataLifecycleAuthorizationError(
          "action_not_allowed",
          action,
          authorization.scope,
          `An authorization for ${action} is required.`,
        ),
      );

const filteredLearning = (snapshot: AxisLearningSnapshot, scope: AxisContextProjectScope) => ({
  evidence: snapshot.evidence.filter((item) => projectEvidence(item, scope)),
  proposals: snapshot.proposals.filter((item) => projectLearningRecord(item, scope)),
  versions: snapshot.versions.filter((item) => projectLearningRecord(item, scope)),
  activeVersions: snapshot.activeVersions.filter((item) => projectLearningRecord(item, scope)),
  activeStates: snapshot.activeStates.filter((item) => projectActiveState(item, scope)),
  lifecycle: snapshot.lifecycle.filter((item) => projectLearningRecord(item, scope)),
});

const evidenceExport = (
  evidence: ReadonlyArray<AxisLearningEvidence>,
  referencedIds: ReadonlyArray<AxisLearningEvidence["id"]>,
  now: string,
) => {
  const byId = new Map(evidence.map((item) => [item.id, item]));
  const ids = [...new Set([...evidence.map((item) => item.id), ...referencedIds])];
  const exported: AxisProjectDataLifecycleEvidenceExport[] = [];
  const references: AxisProjectDataLifecycleEvidenceReference[] = [];

  for (const id of ids) {
    const item = byId.get(id);
    if (item === undefined) {
      exported.push({ id, availability: "unavailable", expiresAt: null, reason: "purged" });
      references.push({ evidenceId: id, availability: "unavailable", reason: "purged" });
    } else if (Date.parse(item.expiresAt) <= Date.parse(now)) {
      exported.push({
        id,
        availability: "unavailable",
        expiresAt: item.expiresAt,
        reason: "expired",
      });
      references.push({ evidenceId: id, availability: "unavailable", reason: "expired" });
    } else {
      exported.push({ id, availability: "available", evidence: item });
      references.push({ evidenceId: id, availability: "available" });
    }
  }

  return { exported, references };
};

const referencedEvidenceIds = (
  proposals: ReadonlyArray<AxisLearningProposal>,
  versions: ReadonlyArray<AxisLearningVersion>,
) => [...new Set([...proposals, ...versions].flatMap((item) => item.evidenceIds))];

export const planAxisProjectDataExport = (
  authorization: AxisProjectDataLifecycleAuthorization,
  dataset: AxisProjectDataLifecycleDataset,
  exportedAt: string,
): Effect.Effect<AxisProjectDataLifecycleExport, AxisProjectDataLifecycleError> =>
  requireAuthorization(authorization, "export").pipe(
    Effect.flatMap(() => {
      const timestampError = validateNow(exportedAt);
      if (timestampError !== undefined) return Effect.fail(timestampError);
      const learningError = validateLearningSnapshot(dataset.learning, authorization.scope);
      if (learningError !== undefined) return Effect.fail(learningError);

      const learning = filteredLearning(dataset.learning, authorization.scope);
      const evidence = evidenceExport(
        learning.evidence,
        referencedEvidenceIds(learning.proposals, learning.versions),
        exportedAt,
      );
      const profile =
        dataset.profile !== undefined &&
        dataset.profile !== null &&
        sameScope(dataset.profile.scope, authorization.scope)
          ? dataset.profile
          : null;

      return Effect.succeed(
        cloneAndFreeze({
          scope: authorization.scope,
          exportedAt,
          profile,
          learning: {
            evidence: evidence.exported,
            evidenceReferences: evidence.references,
            proposals: learning.proposals,
            versions: learning.versions,
            activeVersions: learning.activeVersions,
            activeStates: learning.activeStates,
            lifecycle: learning.lifecycle,
          },
          tasks: (dataset.tasks ?? []).filter((item) => projectTask(item, authorization.scope)),
          taskCommands: (dataset.taskCommands ?? []).filter((item) =>
            projectTaskCommand(item, authorization.scope),
          ),
          taskLifecycle: (dataset.taskLifecycle ?? []).filter((item) =>
            projectTaskLifecycle(item, authorization.scope),
          ),
        }),
      );
    }),
  );

export const planAxisProjectDataPurge = (
  authorization: AxisProjectDataLifecycleAuthorization,
  dataset: AxisProjectDataLifecycleDataset,
  now: string,
): Effect.Effect<AxisProjectDataLifecyclePurgePlan, AxisProjectDataLifecycleError> =>
  requireAuthorization(authorization, "purge").pipe(
    Effect.flatMap(() => {
      const timestampError = validateNow(now);
      if (timestampError !== undefined) return Effect.fail(timestampError);
      const learningError = validateLearningSnapshot(dataset.learning, authorization.scope);
      if (learningError !== undefined) return Effect.fail(learningError);
      const learning = filteredLearning(dataset.learning, authorization.scope);
      const expired = learning.evidence.filter(
        (item) => Date.parse(item.expiresAt) <= Date.parse(now),
      );
      const references = expired.map((item) => ({
        evidenceId: item.id,
        availability: "unavailable" as const,
        reason: "expired" as const,
      }));
      return Effect.succeed(
        cloneAndFreeze({
          scope: authorization.scope,
          now,
          evidenceIds: expired.map((item) => item.id),
          retainedEvidenceReferences: references,
        }),
      );
    }),
  );

export const planAxisProjectDataDelete = (
  authorization: AxisProjectDataLifecycleAuthorization,
  dataset: AxisProjectDataLifecycleDataset,
): Effect.Effect<AxisProjectDataLifecycleDeletePlan, AxisProjectDataLifecycleError> =>
  requireAuthorization(authorization, "delete").pipe(
    Effect.flatMap(() => {
      const learningError = validateLearningSnapshot(dataset.learning, authorization.scope);
      if (learningError !== undefined) return Effect.fail(learningError);
      const learning = filteredLearning(dataset.learning, authorization.scope);
      const ownedProposalIds = new Set(learning.proposals.map((item) => item.id));
      const referencedProposalIds = new Set([
        ...learning.versions.map((item) => item.proposalId),
        ...learning.lifecycle.flatMap((item) =>
          item.proposalId === null ? [] : [item.proposalId],
        ),
      ]);
      // Only retain proposals this project owns. Foreign-key references to
      // proposals owned by other projects are not the responsibility of this
      // project's delete plan.
      const retainedProposalIds = new Set(
        [...referencedProposalIds].filter((id) => ownedProposalIds.has(id)),
      );
      return Effect.succeed(
        cloneAndFreeze({
          scope: authorization.scope,
          mutable: {
            deleteProfile:
              dataset.profile !== undefined &&
              dataset.profile !== null &&
              sameScope(dataset.profile.scope, authorization.scope),
            evidenceIds: learning.evidence.map((item) => item.id),
            proposalIds: learning.proposals
              .filter((item) => !retainedProposalIds.has(item.id))
              .map((item) => item.id),
            activeVersionTargets: [
              ...new Set([
                ...learning.activeVersions.map((item) => item.targetKey),
                ...learning.activeStates.map((item) => item.targetKey),
              ]),
            ],
            taskIds: (dataset.tasks ?? [])
              .filter((item) => projectTask(item, authorization.scope))
              .map((item) => item.id),
            taskCommandIds: (dataset.taskCommands ?? [])
              .filter((item) => projectTaskCommand(item, authorization.scope))
              .map((item) => item.commandId),
            taskLifecycleIds: (dataset.taskLifecycle ?? [])
              .filter((item) => projectTaskLifecycle(item, authorization.scope))
              .map((item) => item.id),
          },
          retained: {
            proposalIds: [...retainedProposalIds],
            versionIds: learning.versions.map((item) => item.id),
            lifecycleIds: learning.lifecycle.map((item) => item.id),
            reason:
              "Learning versions and lifecycle events are immutable while their Axis context exists; proposals referenced by that history remain to preserve the foreign key and audit references.",
          },
        }),
      );
    }),
  );

export interface AxisProjectDataLifecycleService {
  readonly authorize: (
    request: AxisProjectDataLifecycleAuthorizationRequest,
  ) => Effect.Effect<
    AxisProjectDataLifecycleAuthorization,
    AxisProjectDataLifecycleAuthorizationError
  >;
  readonly export: (
    authorization: AxisProjectDataLifecycleAuthorization,
    dataset: AxisProjectDataLifecycleDataset,
    exportedAt: string,
  ) => Effect.Effect<AxisProjectDataLifecycleExport, AxisProjectDataLifecycleError>;
  readonly purge: (
    authorization: AxisProjectDataLifecycleAuthorization,
    dataset: AxisProjectDataLifecycleDataset,
    now: string,
  ) => Effect.Effect<AxisProjectDataLifecyclePurgePlan, AxisProjectDataLifecycleError>;
  readonly delete: (
    authorization: AxisProjectDataLifecycleAuthorization,
    dataset: AxisProjectDataLifecycleDataset,
  ) => Effect.Effect<AxisProjectDataLifecycleDeletePlan, AxisProjectDataLifecycleError>;
}

export class AxisProjectDataLifecycle extends Context.Service<
  AxisProjectDataLifecycle,
  AxisProjectDataLifecycleService
>()("t3/axis/projects/AxisProjectDataLifecycle") {}

export const make = Effect.succeed({
  authorize: authorizeAxisProjectDataLifecycleAction,
  export: planAxisProjectDataExport,
  purge: planAxisProjectDataPurge,
  delete: planAxisProjectDataDelete,
} satisfies AxisProjectDataLifecycleService);

export const layer = Layer.effect(AxisProjectDataLifecycle, make);

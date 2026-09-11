import type {
  AxisContextProjectScope,
  AxisLearningActivationState,
  AxisLearningDeactivateInput,
  AxisLearningLifecycleEvent,
  AxisLearningProposal,
  AxisLearningProposalStatus,
  AxisLearningScope,
  AxisLearningSnapshot,
  AxisLearningVersion,
  AxisLearningVersionId,
  CommandId,
} from "@t3tools/contracts";

/** Wire shape accepted by activate/rollback; mirrors AxisLearningVersionActionInput's source schema. */
export interface ProjectLearningVersionActionInput {
  readonly id: AxisLearningVersionId;
  readonly scope: AxisLearningScope;
  readonly targetKey: string;
  readonly versionId: AxisLearningVersionId;
  readonly expectedRevision: number;
  readonly commandId: CommandId;
}

export type ProjectLearningProposalGroups = Readonly<
  Record<AxisLearningProposalStatus, ReadonlyArray<AxisLearningProposal>>
>;

export type ProjectLearningVersionAction = "active" | "activate" | "rollback";

export interface ProjectLearningVersionEntry {
  readonly version: AxisLearningVersion;
  /** Never derived from an optimistic write; only from the server's active state. */
  readonly action: ProjectLearningVersionAction;
  readonly activeState: AxisLearningActivationState | null;
}

export interface ProjectLearningHistoryEntry {
  readonly event: AxisLearningLifecycleEvent;
  /** Human label; never surfaces the raw targetKey/fingerprint to the user. */
  readonly label: string;
  readonly previousVersionTitle: string | null;
  readonly versionTitle: string | null;
}

export interface ProjectLearningModel {
  readonly scopeMatches: boolean;
  readonly evidenceCount: number;
  readonly proposalsByStatus: ProjectLearningProposalGroups;
  readonly versionEntries: ReadonlyArray<ProjectLearningVersionEntry>;
  readonly history: ReadonlyArray<ProjectLearningHistoryEntry>;
}

function scopesMatch(
  scope: AxisLearningScope | undefined,
  contextId: AxisLearningSnapshot["contextId"],
  target: AxisContextProjectScope,
): boolean {
  const effectiveContextId = scope?.contextId ?? contextId;
  if (effectiveContextId !== target.contextId) return false;
  if (scope?.project === undefined) return false;
  return (
    scope.project.environmentId === target.project.environmentId &&
    scope.project.projectId === target.project.projectId
  );
}

function findActiveState(
  activeStates: AxisLearningSnapshot["activeStates"],
  version: AxisLearningVersion,
): AxisLearningActivationState | null {
  const scope = version.scope;
  if (scope === undefined) return null;
  return (
    activeStates.find(
      (item) =>
        item.targetKey === version.targetKey &&
        item.scope.contextId === scope.contextId &&
        item.scope.project?.environmentId === scope.project?.environmentId &&
        item.scope.project?.projectId === scope.project?.projectId,
    ) ?? null
  );
}

/**
 * Ordering (not equality) decides activate vs rollback: an activation state
 * only ever reflects the server's current truth, so this never flips to
 * "active" on an optimistic write or a failed/conflicting command.
 */
export function projectLearningVersionAction(
  version: AxisLearningVersion,
  activeState: AxisLearningActivationState | null,
  versions: ReadonlyArray<AxisLearningVersion>,
): ProjectLearningVersionAction {
  if (activeState?.versionId === version.id) return "active";
  if (activeState === null || activeState.versionId === null) return "activate";
  const activeVersion = versions.find((item) => item.id === activeState.versionId);
  return activeVersion && Date.parse(version.createdAt) < Date.parse(activeVersion.createdAt)
    ? "rollback"
    : "activate";
}

function lifecycleLabel(action: AxisLearningLifecycleEvent["action"]): string {
  switch (action) {
    case "submitted":
      return "Submitted for review";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "activated":
      return "Activated";
    case "rolled-back":
      return "Rolled back";
    case "deactivated":
      return "Deactivated";
  }
}

export function buildProjectLearningModel(
  scope: AxisContextProjectScope,
  snapshot: AxisLearningSnapshot | null,
): ProjectLearningModel {
  if (snapshot === null) {
    return {
      scopeMatches: true,
      evidenceCount: 0,
      proposalsByStatus: {
        draft: [],
        "in-review": [],
        approved: [],
        rejected: [],
      },
      versionEntries: [],
      history: [],
    };
  }

  const scopeMatches = snapshot.contextId === scope.contextId;
  const scopedProposals = snapshot.proposals.filter((proposal) =>
    scopesMatch(proposal.scope, snapshot.contextId, scope),
  );
  const proposalsByStatus: ProjectLearningProposalGroups = {
    draft: scopedProposals.filter((proposal) => proposal.status === "draft"),
    "in-review": scopedProposals.filter((proposal) => proposal.status === "in-review"),
    approved: scopedProposals.filter((proposal) => proposal.status === "approved"),
    rejected: scopedProposals.filter((proposal) => proposal.status === "rejected"),
  };

  const scopedVersions = snapshot.versions.filter((version) =>
    scopesMatch(version.scope, snapshot.contextId, scope),
  );
  const versionEntries: ReadonlyArray<ProjectLearningVersionEntry> = scopedVersions.map(
    (version) => {
      const activeState = findActiveState(snapshot.activeStates, version);
      return {
        version,
        action: projectLearningVersionAction(version, activeState, scopedVersions),
        activeState,
      };
    },
  );

  const versionTitleById = new Map(snapshot.versions.map((version) => [version.id, version.title]));
  const history: ReadonlyArray<ProjectLearningHistoryEntry> = snapshot.lifecycle
    .filter((event) => scopesMatch(event.scope, snapshot.contextId, scope))
    .map((event) => ({
      event,
      label: lifecycleLabel(event.action),
      previousVersionTitle:
        event.previousVersionId === null
          ? null
          : (versionTitleById.get(event.previousVersionId) ?? null),
      versionTitle:
        event.versionId === null ? null : (versionTitleById.get(event.versionId) ?? null),
    }));

  return {
    scopeMatches,
    evidenceCount: snapshot.evidence.filter((evidence) =>
      scopesMatch(evidence.provenance.scope, snapshot.contextId, scope),
    ).length,
    proposalsByStatus,
    versionEntries,
    history,
  };
}

export type ProjectLearningVersionActionResult =
  | { readonly ok: true; readonly input: ProjectLearningVersionActionInput }
  | { readonly ok: false; readonly reason: string };

/** Always reads expectedRevision from the last observed active state; never assumes 0 on activate. */
export function buildVersionActionInput(
  entry: ProjectLearningVersionEntry,
  commandId: CommandId,
): ProjectLearningVersionActionResult {
  if (entry.action === "active") {
    return { ok: false, reason: "This version is already active." };
  }
  const scope = entry.version.scope;
  if (scope === undefined) {
    return { ok: false, reason: "This version has no learning scope to activate." };
  }
  return {
    ok: true,
    input: {
      id: entry.version.id,
      scope,
      targetKey: entry.version.targetKey,
      versionId: entry.version.id,
      expectedRevision: entry.activeState?.revision ?? 0,
      commandId,
    },
  };
}

export type ProjectLearningDeactivateResult =
  | { readonly ok: true; readonly input: AxisLearningDeactivateInput }
  | { readonly ok: false; readonly reason: string };

export function buildDeactivateInput(
  entry: ProjectLearningVersionEntry,
  commandId: CommandId,
): ProjectLearningDeactivateResult {
  if (entry.action !== "active" || entry.activeState === null) {
    return { ok: false, reason: "This version is not active." };
  }
  const scope = entry.version.scope;
  if (scope === undefined) {
    return { ok: false, reason: "This version has no learning scope to deactivate." };
  }
  return {
    ok: true,
    input: {
      scope,
      targetKey: entry.version.targetKey,
      expectedRevision: entry.activeState.revision,
      commandId,
    },
  };
}

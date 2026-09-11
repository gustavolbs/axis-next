import type {
  AxisContextProjectScope,
  AxisLearningProposal,
  AxisLearningProposalId,
  AxisLearningVersionId,
  CommandId,
} from "@t3tools/contracts";

export interface ProjectLearningProposalSummary {
  readonly id: AxisLearningProposalId;
  readonly kind: AxisLearningProposal["kind"];
  readonly targetKey: string;
  readonly status: AxisLearningProposal["status"];
  readonly evidenceCount: number;
  readonly updatedAt: string;
}

export interface ProjectLearningProposalDetail extends ProjectLearningProposalSummary {
  readonly evidenceIds: ReadonlyArray<string>;
  readonly versionIds: ReadonlyArray<AxisLearningVersionId>;
}

export interface ProjectLearningActionResult {
  readonly proposalId: AxisLearningProposalId;
  readonly commandId: CommandId;
  readonly status: "accepted" | "rejected" | "activated" | "rolled-back" | "deactivated";
}

export interface ProjectLearningSnapshot {
  readonly scope: AxisContextProjectScope;
  readonly proposals: ReadonlyArray<ProjectLearningProposalSummary>;
  readonly activeVersions: ReadonlyArray<{
    readonly targetKey: string;
    readonly versionId: AxisLearningVersionId | null;
    readonly revision: number;
    readonly updatedAt: string;
  }>;
  readonly engineState: "available" | "absent" | "offline" | "unconfigured";
  readonly lastImprovementRunAt: string | null;
}

export const summarizeProposal = (
  proposal: AxisLearningProposal,
): ProjectLearningProposalSummary => ({
  id: proposal.id,
  kind: proposal.kind,
  targetKey: proposal.targetKey,
  status: proposal.status,
  evidenceCount: proposal.evidenceIds.length,
  updatedAt: proposal.updatedAt,
});

export const groupProposalsByProject = (
  scopes: ReadonlyArray<AxisContextProjectScope>,
  proposals: ReadonlyArray<AxisLearningProposal>,
): ReadonlyMap<string, ReadonlyArray<AxisLearningProposal>> => {
  const out = new Map<string, AxisLearningProposal[]>();
  for (const proposal of proposals) {
    const scope = proposal.scope;
    if (scope === undefined) continue;
    const scopeKey = scope.contextId;
    if (scopeKey === undefined) continue;
    const projectId = scope.project?.projectId ?? "context-only";
    const key = `${scopeKey}|${projectId}`;
    const list = out.get(key) ?? [];
    list.push(proposal);
    out.set(key, list);
  }
  void scopes;
  return out;
};

export const buildApproveAction = (input: {
  readonly proposalId: AxisLearningProposalId;
  readonly commandId: CommandId;
  readonly expectedRevision: number;
  readonly note: string | null;
}): {
  readonly proposalId: AxisLearningProposalId;
  readonly commandId: CommandId;
  readonly expectedRevision: number;
  readonly note: string | null;
} => input;

export const buildActivateAction = (input: {
  readonly proposalId: AxisLearningProposalId;
  readonly versionId: AxisLearningVersionId;
  readonly commandId: CommandId;
  readonly expectedRevision: number;
}): {
  readonly proposalId: AxisLearningProposalId;
  readonly versionId: AxisLearningVersionId;
  readonly commandId: CommandId;
  readonly expectedRevision: number;
} => input;

export const proposalDetailToSummary = (
  detail: ProjectLearningProposalDetail,
): ProjectLearningProposalSummary => ({
  id: detail.id,
  kind: detail.kind,
  targetKey: detail.targetKey,
  status: detail.status,
  evidenceCount: detail.evidenceCount,
  updatedAt: detail.updatedAt,
});

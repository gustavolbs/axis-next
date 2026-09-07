import {
  AxisLearningEvidenceId,
  AxisLearningProposalId,
  type AxisContextId,
  type AxisLearningActiveVersion,
  type AxisLearningEvidence,
  type AxisLearningProposalDraft,
  type AxisLearningProposalKind,
  type AxisLearningVersion,
} from "@t3tools/contracts";

export interface ManualLearningEvidenceInput {
  readonly contextId: AxisContextId;
  readonly id: string;
  readonly sourceId: string;
  readonly summary: string;
  readonly observedAt: string;
  readonly expiresAt: string;
}

export function buildManualLearningEvidence(
  input: ManualLearningEvidenceInput,
): AxisLearningEvidence {
  return {
    id: AxisLearningEvidenceId.make(input.id),
    provenance: {
      contextId: input.contextId,
      sourceKind: "user-correction",
      sourceId: input.sourceId.trim(),
      observedAt: input.observedAt,
      fingerprint: `manual-${input.id}`,
    },
    summary: input.summary.trim(),
    createdAt: input.observedAt,
    expiresAt: input.expiresAt,
  };
}

export interface ManualLearningProposalInput {
  readonly contextId: AxisContextId;
  readonly id: string;
  readonly kind: AxisLearningProposalKind;
  readonly targetKey: string;
  readonly title: string;
  readonly rationale: string;
  readonly evidenceId: AxisLearningEvidenceId;
  readonly change: string;
}

export function buildManualLearningProposal(
  input: ManualLearningProposalInput,
): AxisLearningProposalDraft {
  return {
    id: AxisLearningProposalId.make(input.id),
    contextId: input.contextId,
    kind: input.kind,
    targetKey: input.targetKey.trim(),
    title: input.title.trim(),
    rationale: input.rationale.trim(),
    evidenceIds: [input.evidenceId],
    change: { format: "instructions", content: input.change.trim() },
  };
}

export type LearningVersionAction = "active" | "activate" | "rollback";

export function learningVersionAction(
  version: AxisLearningVersion,
  activeVersions: ReadonlyArray<AxisLearningActiveVersion>,
  versions: ReadonlyArray<AxisLearningVersion> = [],
): LearningVersionAction {
  const active = activeVersions.find((item) => item.targetKey === version.targetKey);
  if (active?.versionId === version.id) return "active";
  if (!active) return "activate";
  const activeVersion = versions.find((item) => item.id === active.versionId);
  return activeVersion && Date.parse(version.createdAt) < Date.parse(activeVersion.createdAt)
    ? "rollback"
    : "activate";
}

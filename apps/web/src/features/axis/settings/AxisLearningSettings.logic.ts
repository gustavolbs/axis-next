import {
  AXIS_LEARNING_ENGINE_MAX_EVIDENCE_REFS,
  AxisLearningEvidenceId,
  AxisLearningProposalId,
  AxisProjectRuleId,
  AxisProjectProfileSourceId,
  type AxisContextId,
  type AxisLearningActiveVersion,
  type AxisLearningEvidence,
  type AxisLearningProposalDraft,
  type AxisLearningProposalKind,
  type AxisLearningVersion,
  type AxisLearningScope,
} from "@t3tools/contracts";

export function learningAnalysisEvidenceIds(evidence: ReadonlyArray<AxisLearningEvidence>) {
  return evidence
    .toSorted(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
    )
    .slice(0, AXIS_LEARNING_ENGINE_MAX_EVIDENCE_REFS)
    .map((item) => item.id);
}

export interface ManualLearningEvidenceInput {
  readonly contextId: AxisContextId;
  readonly scope?: AxisLearningScope;
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
      ...(input.scope === undefined ? {} : { scope: input.scope }),
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
  readonly scope?: AxisLearningScope;
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
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    kind: input.kind,
    targetKey: input.targetKey.trim(),
    title: input.title.trim(),
    rationale: input.rationale.trim(),
    evidenceIds: [input.evidenceId],
    change: {
      op: "set-rule",
      rule: {
        id: AxisProjectRuleId.make(`manual-${input.id}`),
        category: "instruction",
        text: input.change.trim(),
        origin: "manual",
        sourceRef: AxisProjectProfileSourceId.make("axis-learning-settings"),
        sourceRevision: 0,
        paths: [],
        strength: "explicit",
        effect: "preference",
        restriction: null,
        defaultValue: null,
        condition: null,
      },
    },
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

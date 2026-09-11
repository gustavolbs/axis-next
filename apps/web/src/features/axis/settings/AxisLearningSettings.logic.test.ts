import { describe, expect, it } from "vite-plus/test";

import {
  AxisContextId,
  AxisLearningEvidenceId,
  AxisLearningProposalId,
  AxisLearningVersionId,
  EnvironmentId,
  ProjectId,
  type AxisLearningVersion,
  AxisProjectRuleId,
  AxisProjectProfileSourceId,
} from "@t3tools/contracts";

import {
  buildManualLearningEvidence,
  buildManualLearningProposal,
  learningVersionAction,
  learningAnalysisEvidenceIds,
} from "./AxisLearningSettings.logic";

const contextId = AxisContextId.make("company-a");
const now = "2026-09-06T12:00:00.000Z";

function version(id: string, targetKey = "skill:review", createdAt = now): AxisLearningVersion {
  return {
    id: AxisLearningVersionId.make(id),
    proposalId: AxisLearningProposalId.make(`proposal-${id}`),
    contextId,
    kind: "provider-skill",
    targetKey,
    title: "Review pull requests",
    rationale: "Repeated corrections show a stable preference.",
    evidenceIds: [AxisLearningEvidenceId.make("evidence-1")],
    change: {
      op: "set-rule",
      rule: {
        id: AxisProjectRuleId.make("rule-version"),
        category: "instruction",
        text: "Prefer focused diffs.",
        origin: "manual",
        sourceRef: AxisProjectProfileSourceId.make("source-version"),
        sourceRevision: 0,
        paths: [],
        strength: "explicit",
        effect: "preference",
        restriction: null,
        defaultValue: null,
        condition: null,
      },
    },
    approvedBy: "session:test",
    createdAt,
  };
}

describe("Axis Learning settings logic", () => {
  it("bounds analysis to recent evidence without mutating the retained history", () => {
    const evidence = Array.from({ length: 40 }, (_, index) =>
      buildManualLearningEvidence({
        contextId: AxisContextId.make("company"),
        id: `evidence-${index}`,
        sourceId: "manual",
        summary: "Observed outcome",
        observedAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
        expiresAt: "2026-10-01T00:00:00.000Z",
      }),
    );
    const selected = learningAnalysisEvidenceIds(evidence);
    expect(selected).toHaveLength(32);
    expect(selected[0]).toBe("evidence-39");
    expect(selected.at(-1)).toBe("evidence-8");
    expect(evidence[0]?.id).toBe("evidence-0");
    expect(learningAnalysisEvidenceIds([])).toEqual([]);
  });
  it("keeps manually recorded evidence inside the selected context", () => {
    const evidence = buildManualLearningEvidence({
      contextId,
      id: "evidence-1",
      sourceId: "manual-settings",
      summary: "  Prefer focused diffs.  ",
      observedAt: now,
      expiresAt: "2026-10-06T12:00:00.000Z",
    });

    expect(evidence.provenance.contextId).toBe(contextId);
    expect(evidence.summary).toBe("Prefer focused diffs.");
    expect(evidence.provenance.fingerprint).toBe("manual-evidence-1");
  });

  it("preserves an explicitly selected project scope on manual evidence and proposals", () => {
    const scope = {
      contextId,
      project: {
        environmentId: EnvironmentId.make("laptop"),
        projectId: ProjectId.make("project-a"),
      },
    };
    const evidence = buildManualLearningEvidence({
      contextId,
      scope,
      id: "evidence-project",
      sourceId: "manual-settings",
      summary: "Project-specific correction.",
      observedAt: now,
      expiresAt: "2026-10-06T12:00:00.000Z",
    });
    const proposal = buildManualLearningProposal({
      contextId,
      scope,
      id: "proposal-project",
      kind: "provider-skill",
      targetKey: "skill:review",
      title: "Project review",
      rationale: "The preference is local to this project.",
      evidenceId: evidence.id,
      change: "Prefer focused diffs.",
    });

    expect(evidence.provenance.scope).toEqual(scope);
    expect(proposal.scope).toEqual(scope);
  });

  it("builds a reviewable proposal from evidence without activating it", () => {
    const proposal = buildManualLearningProposal({
      contextId,
      id: "proposal-1",
      kind: "provider-skill",
      targetKey: " skill:review ",
      title: " Improve review skill ",
      rationale: " Repeated correction. ",
      evidenceId: AxisLearningEvidenceId.make("evidence-1"),
      change: " Prefer focused diffs. ",
    });

    expect(proposal.contextId).toBe(contextId);
    expect(proposal.targetKey).toBe("skill:review");
    expect(proposal).not.toHaveProperty("status");
    expect(proposal.change).toMatchObject({
      op: "set-rule",
      rule: { text: "Prefer focused diffs." },
    });
  });

  it("requires explicit activation and identifies switches as rollbacks", () => {
    const first = version("version-1", "skill:review", "2026-09-05T12:00:00.000Z");
    const second = version("version-2", "skill:review", "2026-09-06T12:00:00.000Z");

    expect(learningVersionAction(first, [])).toBe("activate");
    expect(
      learningVersionAction(
        first,
        [{ contextId, targetKey: first.targetKey, versionId: first.id, activatedAt: now }],
        [first, second],
      ),
    ).toBe("active");
    expect(
      learningVersionAction(
        second,
        [{ contextId, targetKey: first.targetKey, versionId: first.id, activatedAt: now }],
        [first, second],
      ),
    ).toBe("activate");
    expect(
      learningVersionAction(
        first,
        [{ contextId, targetKey: second.targetKey, versionId: second.id, activatedAt: now }],
        [first, second],
      ),
    ).toBe("rollback");
  });
});

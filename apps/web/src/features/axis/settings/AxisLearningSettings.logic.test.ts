import { describe, expect, it } from "vite-plus/test";

import {
  AxisContextId,
  AxisLearningEvidenceId,
  AxisLearningProposalId,
  AxisLearningVersionId,
  type AxisLearningVersion,
} from "@t3tools/contracts";

import {
  buildManualLearningEvidence,
  buildManualLearningProposal,
  learningVersionAction,
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
    change: { content: "Prefer focused diffs." },
    approvedBy: "session:test",
    createdAt,
  };
}

describe("Axis Learning settings logic", () => {
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
    expect(proposal.change).toEqual({ format: "instructions", content: "Prefer focused diffs." });
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

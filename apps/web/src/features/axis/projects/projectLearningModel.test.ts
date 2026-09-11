import { assert, describe, it } from "@effect/vitest";

import {
  buildActivateAction,
  buildApproveAction,
  groupProposalsByProject,
  proposalDetailToSummary,
  summarizeProposal,
} from "./projectLearningModel.ts";
import {
  AxisContextId,
  AxisLearningEvidenceId,
  AxisLearningProposal,
  AxisLearningProposalId,
  AxisLearningVersionId,
  CommandId,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";

const baseProposal: AxisLearningProposal = {
  id: AxisLearningProposalId.make("prop-1"),
  contextId: AxisContextId.make("ctx-1"),
  scope: {
    contextId: AxisContextId.make("ctx-1"),
    project: {
      environmentId: EnvironmentId.make("env-1"),
      projectId: ProjectId.make("proj-1"),
    },
  },
  targetKey: "tests:auth",
  kind: "workflow-recommendation",
  title: "Reuse auth helper in tests",
  rationale: "Three PRs reused the same auth helper.",
  evidenceIds: [AxisLearningEvidenceId.make("ev-1"), AxisLearningEvidenceId.make("ev-2")],
  change: {
    kind: "legacy-unknown",
    value: { op: "noop", description: "Reuse the auth helper across endpoint tests." },
  },
  status: "in-review",
  createdAt: "2026-09-11T00:00:00.000Z",
  updatedAt: "2026-09-11T01:00:00.000Z",
  reviewedAt: null,
  reviewedBy: null,
  reviewNote: null,
};

describe("projectLearningModel", () => {
  it("summarizeProposal returns a stable summary", () => {
    const summary = summarizeProposal(baseProposal);
    assert.equal(summary.id, baseProposal.id);
    assert.equal(summary.targetKey, "tests:auth");
    assert.equal(summary.evidenceCount, 2);
  });

  it("proposalDetailToSummary collapses to the same shape", () => {
    const detail = {
      ...summarizeProposal(baseProposal),
      rationale: "Repeated diff in three PRs",
      evidenceIds: ["ev-1"],
      versionIds: [],
    };
    const summary = proposalDetailToSummary(detail);
    assert.equal(summary.id, detail.id);
    assert.equal(summary.evidenceCount, 2);
  });

  it("groupProposalsByProject groups by scope and projectId", () => {
    const grouped = groupProposalsByProject([], [baseProposal]);
    assert.equal(grouped.size, 1);
    const key = [...grouped.keys()][0];
    assert.equal(key?.includes("ctx-1"), true);
  });

  it("buildApproveAction forwards the commandId and expectedRevision", () => {
    const action = buildApproveAction({
      proposalId: AxisLearningProposalId.make("prop-1"),
      commandId: CommandId.make("cmd-1"),
      expectedRevision: 3,
      note: "Looks good",
    });
    assert.equal(action.expectedRevision, 3);
    assert.equal(action.note, "Looks good");
  });

  it("buildActivateAction requires versionId", () => {
    const action = buildActivateAction({
      proposalId: AxisLearningProposalId.make("prop-1"),
      versionId: AxisLearningVersionId.make("ver-1"),
      commandId: CommandId.make("cmd-1"),
      expectedRevision: 1,
    });
    assert.equal(action.versionId, "ver-1");
  });
});

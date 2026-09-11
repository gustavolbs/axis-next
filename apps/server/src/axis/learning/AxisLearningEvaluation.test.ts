import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { AxisContextId } from "../../../../../packages/contracts/src/axisContext.ts";
import {
  AxisLearningEvidence,
  AxisLearningEvidenceId,
} from "../../../../../packages/contracts/src/axisLearning.ts";
import { AxisLearningEngineCandidateProposal } from "../../../../../packages/contracts/src/axisLearningEngine.ts";
import {
  AxisProjectProfileSourceId,
  AxisProjectRuleId,
  AxisWorkflowStepId,
} from "../../../../../packages/contracts/src/axisProjectProfile.ts";
import {
  evaluateAxisLearningProposal,
  type AxisLearningEvaluationInput,
} from "./AxisLearningEvaluation.ts";

const evidence = (id: string, summary = "A verified workflow outcome.") => ({
  id: AxisLearningEvidenceId.make(id),
  provenance: {
    contextId: AxisContextId.make("company_a"),
    sourceKind: "thread-turn",
    sourceId: `thread:${id}`,
    observedAt: "2026-09-09T09:00:00.000Z",
    fingerprint: `sha256:${id}`,
  },
  summary,
  createdAt: "2026-09-09T09:01:00.000Z",
  expiresAt: "2026-10-09T09:01:00.000Z",
});

const decodeEvidence = Schema.decodeUnknownSync(AxisLearningEvidence);
const decodeCandidate = Schema.decodeUnknownSync(AxisLearningEngineCandidateProposal);

const candidate = (evidenceIds = ["evidence_1"], instruction = "Run the focused test suite.") =>
  decodeCandidate({
    contextId: AxisContextId.make("company_a"),
    kind: "workflow-recommendation",
    targetKey: "workflow:verify",
    title: "Focused verification",
    rationale: "The workflow outcome supports this small improvement.",
    evidenceIds: evidenceIds.map((id) => AxisLearningEvidenceId.make(id)),
    change: {
      op: "set-workflow-step",
      step: {
        id: AxisWorkflowStepId.make("verify"),
        title: "Verify",
        instruction,
        required: true,
        order: 0,
      },
    },
  });

const input = (
  overrides: Partial<AxisLearningEvaluationInput> = {},
): AxisLearningEvaluationInput => ({
  candidate: candidate(),
  sources: [],
  rules: [],
  examples: [decodeEvidence(evidence("evidence_1"))],
  previousDecisions: [],
  ...overrides,
});

it("AxisLearningEvaluation rejects a candidate contradicting an explicit rule", () => {
  const rule = {
    id: AxisProjectRuleId.make("rule_no_npm"),
    category: "command" as const,
    text: "Do not use npm in this project.",
    origin: "manual" as const,
    sourceRef: AxisProjectProfileSourceId.make("policy"),
    sourceRevision: 1,
    paths: [],
    strength: "explicit" as const,
    effect: "restriction" as const,
    restriction: "npm is forbidden",
    defaultValue: null,
    condition: null,
  };
  const decision = evaluateAxisLearningProposal(
    input({ candidate: candidate(["evidence_1"], "Run npm test."), rules: [rule] }),
  );
  expect(decision.status).toBe("rejected");
  expect(decision.reason).toContain("rule_no_npm");
});

it("AxisLearningEvaluation rejects repeated rejected content without new evidence", () => {
  const rejected = candidate();
  const decision = evaluateAxisLearningProposal(
    input({
      previousDecisions: [{ ...rejected, status: "rejected" }],
    }),
  );
  expect(decision.status).toBe("rejected");
  expect(decision.reason).toContain("new evidence");
});

it("AxisLearningEvaluation allows rejected content to return with new evidence for review", () => {
  const rejected = candidate();
  const decision = evaluateAxisLearningProposal(
    input({
      candidate: candidate(["evidence_1", "evidence_2"]),
      examples: [
        decodeEvidence(evidence("evidence_1")),
        decodeEvidence(evidence("evidence_2", "A new verified outcome.")),
      ],
      previousDecisions: [{ ...rejected, status: "rejected" }],
    }),
  );
  expect(decision.status).toBe("accepted-for-review");
});

it("AxisLearningEvaluation returns no-change for an already evaluated non-rejected proposal", () => {
  const prior = candidate();
  const decision = evaluateAxisLearningProposal(
    input({ previousDecisions: [{ ...prior, status: "in-review" }] }),
  );
  expect(decision.status).toBe("no-change");
});

it("AxisLearningEvaluation rejects capability, permission, and configuration expansion", () => {
  const decision = evaluateAxisLearningProposal(
    input({
      candidate: candidate(
        ["evidence_1"],
        "Enable the MCP capability and grant access with --config settings.json.",
      ),
    }),
  );
  expect(decision.status).toBe("rejected");
  expect(decision.reason).toContain("capabilities");
});

import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AxisOnboardingRun,
  AxisOnboardingRunId,
  AxisOnboardingDecision,
} from "../../../../../packages/contracts/src/axisOnboarding.ts";
import { AxisProjectProfile } from "../../../../../packages/contracts/src/axisProjectProfile.ts";
import { applyAxisOnboarding, AxisOnboardingApplyError } from "./AxisOnboardingApply.ts";

const decodeRun = Schema.decodeUnknownSync(AxisOnboardingRun);
const decodeProfile = Schema.decodeUnknownSync(AxisProjectProfile);
const decodeDecision = Schema.decodeUnknownSync(AxisOnboardingDecision);

const scope = { contextId: "company_a", project: { environmentId: "laptop", projectId: "axis" } };
const run = decodeRun({
  id: "onboarding-1",
  scope,
  execution: { threadId: "thread-1", turnId: "turn-1", commandId: "command-1" },
  status: "completed",
  sources: [{ id: "source-readme", path: "README.md", kind: "instruction", status: "read", error: null }],
  digests: [{ id: "digest-readme", sourceId: "source-readme", algorithm: "sha256", value: "digest-v1", observedAt: "2026-09-10T12:00:00.000Z" }],
  facts: [],
  candidateRules: [{ id: "candidate-tests", category: "test-policy", text: "Run focused tests before publishing.", effect: "restriction", sourceIds: ["source-readme"], factIds: [] }],
  conflicts: [],
  decisions: [],
  error: null,
  startedAt: "2026-09-10T11:00:00.000Z",
  finishedAt: "2026-09-10T12:00:00.000Z",
});

const profile = decodeProfile({
  scope,
  revision: 2,
  sources: [],
  facts: [],
  rules: [],
  manualDecisions: [],
  workflow: [],
  tokenEfficiencyPolicies: [],
  updatedAt: "2026-09-10T10:00:00.000Z",
});

it("applies only explicitly accepted candidates and records the decision", () => {
  const result = applyAxisOnboarding({
    profile,
    run,
    decisions: [decodeDecision({ id: "decision-1", candidateRuleId: "candidate-tests", decision: "accept", note: null })],
    expectedProfileRevision: 2,
    decidedAt: "2026-09-10T12:30:00.000Z",
  });

  expect(result.profile.revision).toBe(2);
  expect(result.profile.rules).toHaveLength(1);
  expect(result.profile.rules[0]?.origin).toBe("learning");
  expect(result.profile.manualDecisions[0]?.decision).toBe("accept");
  expect(result.acceptedCandidateIds).toEqual([AxisOnboardingRunId.make("candidate-tests")]);
});

it("is idempotent for an identical refresh", () => {
  const input = {
    profile,
    run,
    decisions: [decodeDecision({ id: "decision-1", candidateRuleId: "candidate-tests", decision: "accept", note: null })],
    expectedProfileRevision: 2,
    decidedAt: "2026-09-10T12:30:00.000Z",
  };
  const first = applyAxisOnboarding(input).profile;
  const second = applyAxisOnboarding({ ...input, profile: first }).profile;

  expect(second.sources).toHaveLength(1);
  expect(second.rules).toHaveLength(1);
  expect(second.manualDecisions).toHaveLength(1);
  expect(second.facts).toHaveLength(0);
});

it("rejects incomplete runs and stale profile revisions", () => {
  expect(() => applyAxisOnboarding({
    profile,
    run: decodeRun({ ...run, status: "cancelled" }),
    decisions: [],
    expectedProfileRevision: 2,
    decidedAt: "2026-09-10T12:30:00.000Z",
  })).toThrow(AxisOnboardingApplyError);
  expect(() => applyAxisOnboarding({
    profile,
    run,
    decisions: [],
    expectedProfileRevision: 1,
    decidedAt: "2026-09-10T12:30:00.000Z",
  })).toThrow(AxisOnboardingApplyError);
});

it("invalidates only the learning rule whose source digest changed", () => {
  const first = applyAxisOnboarding({
    profile,
    run,
    decisions: [decodeDecision({ id: "decision-1", candidateRuleId: "candidate-tests", decision: "accept", note: null })],
    expectedProfileRevision: 2,
    decidedAt: "2026-09-10T12:30:00.000Z",
  }).profile;
  const refreshed = applyAxisOnboarding({
    profile: first,
    run: decodeRun({ ...run, digests: [{ ...run.digests[0], value: "digest-v2" }] }),
    decisions: [],
    expectedProfileRevision: 2,
    decidedAt: "2026-09-10T13:30:00.000Z",
  });

  expect(refreshed.invalidatedRuleIds).toEqual([first.rules[0]!.id]);
  expect(refreshed.profile.rules).toHaveLength(0);
});

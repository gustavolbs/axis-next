import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AxisOnboardingRun,
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
  sources: [
    { id: "source-readme", path: "README.md", kind: "instruction", status: "read", error: null },
  ],
  digests: [
    {
      id: "digest-readme",
      sourceId: "source-readme",
      algorithm: "sha256",
      value: "digest-v1",
      observedAt: "2026-09-10T12:00:00.000Z",
    },
  ],
  facts: [],
  candidateRules: [
    {
      id: "candidate-tests",
      category: "test-policy",
      text: "Run focused tests before publishing.",
      effect: "restriction",
      sourceIds: ["source-readme"],
      factIds: [],
    },
  ],
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
    decisions: [
      decodeDecision({
        id: "decision-1",
        candidateRuleId: "candidate-tests",
        decision: "accept",
        note: null,
      }),
    ],
    expectedProfileRevision: 2,
    decidedAt: "2026-09-10T12:30:00.000Z",
  });

  expect(result.profile.revision).toBe(2);
  expect(result.profile.rules).toHaveLength(1);
  expect(result.profile.rules[0]?.origin).toBe("learning");
  expect(result.profile.manualDecisions[0]?.decision).toBe("accept");
  expect(result.acceptedCandidateIds).toEqual(["candidate-tests"]);
});

it("is idempotent for an identical refresh", () => {
  const input = {
    profile,
    run,
    decisions: [
      decodeDecision({
        id: "decision-1",
        candidateRuleId: "candidate-tests",
        decision: "accept",
        note: null,
      }),
    ],
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
  expect(() =>
    applyAxisOnboarding({
      profile,
      run: decodeRun({ ...run, status: "cancelled" }),
      decisions: [],
      expectedProfileRevision: 2,
      decidedAt: "2026-09-10T12:30:00.000Z",
    }),
  ).toThrow(AxisOnboardingApplyError);
  expect(() =>
    applyAxisOnboarding({
      profile,
      run,
      decisions: [],
      expectedProfileRevision: 1,
      decidedAt: "2026-09-10T12:30:00.000Z",
    }),
  ).toThrow(AxisOnboardingApplyError);
});

it("invalidates only the learning rule whose source digest changed", () => {
  const first = applyAxisOnboarding({
    profile,
    run,
    decisions: [
      decodeDecision({
        id: "decision-1",
        candidateRuleId: "candidate-tests",
        decision: "accept",
        note: null,
      }),
    ],
    expectedProfileRevision: 2,
    decidedAt: "2026-09-10T12:30:00.000Z",
  }).profile;
  const refreshed = applyAxisOnboarding({
    profile: first,
    run: decodeRun({
      ...run,
      candidateRules: [],
      digests: [{ ...run.digests[0], value: "digest-v2" }],
    }),
    decisions: [],
    expectedProfileRevision: 2,
    decidedAt: "2026-09-10T13:30:00.000Z",
  });

  expect(refreshed.invalidatedRuleIds).toEqual([first.rules[0]!.id]);
  expect(refreshed.profile.rules).toHaveLength(0);
});

it("invalidates learning rules whose source becomes unreadable on refresh", () => {
  const first = applyAxisOnboarding({
    profile,
    run,
    decisions: [
      decodeDecision({
        id: "decision-1",
        candidateRuleId: "candidate-tests",
        decision: "accept",
        note: null,
      }),
    ],
    expectedProfileRevision: 2,
    decidedAt: "2026-09-10T12:30:00.000Z",
  }).profile;
  expect(first.rules).toHaveLength(1);

  // Source turned unreadable in the refresh.
  const refreshed = applyAxisOnboarding({
    profile: first,
    run: decodeRun({
      ...run,
      candidateRules: [],
      sources: [
        {
          id: "source-readme",
          path: "README.md",
          kind: "instruction",
          status: "failed",
          error: "permission denied",
        },
      ],
      digests: [],
    }),
    decisions: [],
    expectedProfileRevision: first.revision,
    decidedAt: "2026-09-10T13:30:00.000Z",
  });

  expect(refreshed.invalidatedRuleIds).toContain(first.rules[0]!.id);
  expect(refreshed.profile.rules).toHaveLength(0);
});

const decisionFor = (decision: AxisOnboardingDecision["decision"]) =>
  decodeDecision({ id: "decision-1", candidateRuleId: "candidate-tests", decision, note: null });

const applyInput = {
  profile,
  run,
  decisions: [decisionFor("accept")],
  expectedProfileRevision: 2,
  decidedAt: "2026-09-10T12:30:00.000Z",
};

it.each(["reject", "defer"] as const)(
  "revokes an accepted rule on %s without a digest change",
  (decision) => {
    const accepted = applyAxisOnboarding(applyInput).profile;
    const result = applyAxisOnboarding({
      ...applyInput,
      profile: accepted,
      decisions: [decisionFor(decision)],
    });
    expect(result.profile.rules).toEqual([]);
    expect(result.invalidatedRuleIds).toEqual(["onboarding-candidate-tests"]);
    expect(result.acceptedCandidateIds).toEqual([]);
    expect(result.profile.manualDecisions[0]?.decision).toBe(decision);
    expect(result.profile.sources).toEqual(accepted.sources);
  },
);

it.each(["accept", "reject", "defer"] as const)(
  "preserves manual overrides and unrelated rules on %s",
  (decision) => {
    const accepted = applyAxisOnboarding(applyInput).profile;
    const overridden = decodeProfile({
      ...accepted,
      rules: [
        { ...accepted.rules[0], origin: "manual", text: "Manual override." },
        { ...accepted.rules[0], id: "unrelated-rule" },
      ],
    });
    const result = applyAxisOnboarding({
      ...applyInput,
      profile: overridden,
      decisions: [decisionFor(decision)],
    });
    expect(result.profile.rules).toEqual(overridden.rules);
    expect(result.invalidatedRuleIds).toEqual([]);
  },
);

const twoCandidates = decodeRun({
  ...run,
  candidateRules: [
    ...run.candidateRules,
    { ...run.candidateRules[0], id: "candidate-second", text: "Second candidate." },
  ],
});
const secondDecision = decodeDecision({
  id: "decision-2",
  candidateRuleId: "candidate-second",
  decision: "defer",
  note: null,
});

it.each([
  { name: "empty", decisions: [] },
  { name: "partial", decisions: [decisionFor("accept")] },
  {
    name: "duplicate candidate",
    decisions: [decisionFor("accept"), decisionFor("reject"), secondDecision],
  },
  {
    name: "duplicate decision ID",
    decisions: [decisionFor("accept"), { ...secondDecision, id: decisionFor("accept").id }],
  },
  {
    name: "unknown candidate",
    decisions: [
      decisionFor("accept"),
      decodeDecision({ ...secondDecision, candidateRuleId: "unknown" }),
    ],
  },
])("rejects $name decisions", ({ decisions }) => {
  expect(() => applyAxisOnboarding({ ...applyInput, run: twoCandidates, decisions })).toThrow(
    expect.objectContaining({ reason: "invalid_decision" }),
  );
});

it("requires explicit defer for the rest of the candidate set", () => {
  const result = applyAxisOnboarding({
    ...applyInput,
    run: twoCandidates,
    decisions: [secondDecision, decisionFor("accept")],
  });
  expect(result.profile.rules.map((rule) => rule.id)).toEqual(["onboarding-candidate-tests"]);
  expect(result.profile.manualDecisions.map((decision) => decision.decision)).toEqual([
    "accept",
    "defer",
  ]);
});

it("accepts empty decisions only when there are no candidates", () => {
  const result = applyAxisOnboarding({
    ...applyInput,
    run: decodeRun({ ...run, candidateRules: [] }),
    decisions: [],
  });
  expect(result.profile.rules).toEqual([]);
});

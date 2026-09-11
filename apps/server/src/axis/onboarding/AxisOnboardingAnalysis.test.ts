import { expect, it } from "@effect/vitest";

import {
  analyzeAxisOnboarding,
  AxisOnboardingAnalysisError,
  type AxisOnboardingAnalysisInput,
} from "./AxisOnboardingAnalysis.ts";
import {
  AxisOnboardingFactId,
  AxisOnboardingSourceId,
} from "../../../../../packages/contracts/src/axisOnboarding.ts";
import { AxisContextId } from "../../../../../packages/contracts/src/axisContext.ts";
import {
  EnvironmentId,
  ProjectId as AxisProjectId,
} from "../../../../../packages/contracts/src/baseSchemas.ts";
import {
  AxisProjectProfileSourceId,
  AxisProjectRuleId,
} from "../../../../../packages/contracts/src/axisProjectProfile.ts";

const scope = {
  contextId: AxisContextId.make("company"),
  project: {
    environmentId: EnvironmentId.make("env-local"),
    projectId: AxisProjectId.make("project-axis"),
  },
};

const source = (id: string, path: string, kind: "instruction" | "manifest", content: string) => ({
  id: AxisOnboardingSourceId.make(id),
  path,
  kind,
  status: "read" as const,
  error: null,
  content,
});

const fact = (id: string, sourceId: string, key: string, value: string) => ({
  id: AxisOnboardingFactId.make(id),
  sourceId: AxisOnboardingSourceId.make(sourceId),
  key,
  value,
  confidence: "explicit" as const,
});

const baseInput = (): AxisOnboardingAnalysisInput => ({
  scope,
  sources: [
    source(
      "src-instruction",
      "CLAUDE.md",
      "instruction",
      "Run `yarn test` with coverage before opening a change.",
    ),
    source(
      "src-manifest",
      "package.json",
      "manifest",
      '{"scripts":{"test":"pnpm test","test:coverage":"pnpm test:coverage"}}',
    ),
  ],
  facts: [
    fact("fact-test", "src-manifest", "script.test", "pnpm test"),
    fact("fact-coverage", "src-manifest", "script.test:coverage", "pnpm test:coverage"),
    fact("fact-branch", "src-manifest", "branch.source", "feature/onboarding"),
  ],
  effectiveContext: {
    scope,
    rules: [
      {
        id: AxisProjectRuleId.make("pr-target"),
        category: "pull-request-policy",
        text: "Pull requests target main.",
        origin: "manual",
        sourceRef: AxisProjectProfileSourceId.make("profile"),
        sourceRevision: 1,
        paths: [],
        strength: "explicit",
        effect: "restriction",
        restriction: "target must be main",
        defaultValue: null,
        condition: null,
      },
    ],
  },
  modelOutput: {
    scope,
    candidates: [
      {
        category: "test-policy",
        effect: "preference",
        text: "Follow the instruction's test command with coverage.",
        sourceIds: ["src-instruction", "src-manifest"],
        factIds: ["fact-test", "fact-coverage"],
      },
    ],
  },
});

it("records stale test and coverage instructions with traceable candidates and facts", () => {
  const result = analyzeAxisOnboarding(baseInput());

  expect(result.conflicts).toHaveLength(1);
  expect(result.conflicts[0]?.description).toContain("CLAUDE.md");
  expect(result.conflicts[0]?.description).toContain("fact-test");
  expect(
    result.conflicts[0]?.candidateRuleIds.every((id) =>
      result.candidateRules.some((candidate) => candidate.id === id),
    ),
  ).toBe(true);
  expect(
    result.candidateRules.some((candidate) =>
      candidate.factIds.includes(AxisOnboardingFactId.make("fact-coverage")),
    ),
  ).toBe(true);
});

it("generates a separate factual candidate when the provider omits the drift candidates", () => {
  const input = baseInput();
  const result = analyzeAxisOnboarding({
    ...input,
    modelOutput: {
      scope,
      candidates: [
        {
          category: "test-policy",
          effect: "preference",
          text: "Review the test instruction.",
          sourceIds: ["src-instruction"],
          factIds: [],
        },
      ],
    },
  });

  expect(result.conflicts).toHaveLength(1);
  expect(result.candidateRules).toHaveLength(3);
  expect(result.conflicts[0]?.candidateRuleIds).toHaveLength(2);
  expect(
    result.conflicts[0]?.candidateRuleIds.every((id) =>
      result.candidateRules.some((candidate) => candidate.id === id),
    ),
  ).toBe(true);
  expect(
    result.candidateRules.some(
      (candidate) =>
        candidate.text ===
        "Use the distinct test and coverage scripts recorded in the cited project facts.",
    ),
  ).toBe(true);
});

it("does not report drift when the instruction names distinct current commands", () => {
  const input = baseInput();
  const sources = [
    source(
      "src-instruction",
      "CLAUDE.md",
      "instruction",
      "Run `pnpm test` and then `pnpm test:coverage` as separate commands.",
    ),
    input.sources[1]!,
  ];

  const result = analyzeAxisOnboarding({ ...input, sources });
  expect(result.conflicts).toHaveLength(0);
});

it("keeps a source branch fact separate from the effective pull-request target policy", () => {
  const result = analyzeAxisOnboarding(baseInput());

  expect(result.branch.sourceFacts.map((item) => item.key)).toEqual(["branch.source"]);
  expect(result.branch.pullRequestPolicies.map((item) => item.id)).toEqual(["pr-target"]);
  expect(result.branch.sourceFacts[0]?.value).toBe("feature/onboarding");
  expect(result.branch.pullRequestPolicies[0]?.text).toBe("Pull requests target main.");
});

it("rejects malformed, evidenceless, and cross-scope model output", () => {
  const malformed = { ...baseInput(), modelOutput: { candidates: [{ category: "test-policy" }] } };
  expect(() => analyzeAxisOnboarding(malformed)).toThrow(AxisOnboardingAnalysisError);

  const noEvidence = {
    ...baseInput(),
    modelOutput: {
      candidates: [
        {
          category: "test-policy",
          effect: "preference",
          text: "Use the test command.",
          sourceIds: [],
          factIds: [],
        },
      ],
    },
  };
  expect(() => analyzeAxisOnboarding(noEvidence)).toThrow(AxisOnboardingAnalysisError);

  const otherScope = {
    ...baseInput(),
    modelOutput: {
      scope: {
        ...scope,
        project: { ...scope.project, projectId: AxisProjectId.make("other-project") },
      },
      candidates: (baseInput().modelOutput as { readonly candidates: ReadonlyArray<unknown> })
        .candidates,
    },
  };
  expect(() => analyzeAxisOnboarding(otherScope)).toThrow(AxisOnboardingAnalysisError);
});

it("rejects provider activation fields and scope-expanding content", () => {
  const input = baseInput();
  const activation = {
    ...input,
    modelOutput: {
      candidates: [
        {
          category: "test-policy",
          effect: "preference",
          text: "Use the cited test command.",
          sourceIds: ["src-instruction"],
          factIds: [],
          activate: true,
        },
      ],
    },
  };
  expect(() => analyzeAxisOnboarding(activation)).toThrow(AxisOnboardingAnalysisError);

  const scopeExpansion = {
    ...input,
    modelOutput: {
      candidates: [
        {
          category: "test-policy",
          effect: "preference",
          text: "Apply this rule to all projects.",
          sourceIds: ["src-instruction"],
          factIds: [],
        },
      ],
    },
  };
  expect(() => analyzeAxisOnboarding(scopeExpansion)).toThrow(AxisOnboardingAnalysisError);
});

it("rejects facts that are not evidenced by cited readable sources", () => {
  const input = baseInput();
  const crossSource = {
    ...input,
    modelOutput: {
      candidates: [
        {
          category: "test-policy",
          effect: "preference",
          text: "Use the manifest test command.",
          sourceIds: ["src-instruction"],
          factIds: ["fact-test"],
        },
      ],
    },
  };
  expect(() => analyzeAxisOnboarding(crossSource)).toThrow(AxisOnboardingAnalysisError);

  const unreadableSource = {
    ...input,
    sources: [
      {
        ...input.sources[0]!,
        status: "failed" as const,
        error: "permission denied",
        content: null,
      },
      input.sources[1]!,
    ],
    modelOutput: {
      candidates: [
        {
          category: "test-policy",
          effect: "preference",
          text: "Use the test instruction.",
          sourceIds: ["src-instruction"],
          factIds: [],
        },
      ],
    },
  } as AxisOnboardingAnalysisInput;
  expect(() => analyzeAxisOnboarding(unreadableSource)).toThrow(AxisOnboardingAnalysisError);
});

it("returns inactive candidates and rejects attempts to turn source content into target policy", () => {
  const input = baseInput();
  const result = analyzeAxisOnboarding(input);
  expect(result).not.toHaveProperty("apply");
  expect(result).not.toHaveProperty("activeRules");

  const scopeConfusion = {
    ...input,
    modelOutput: {
      candidates: [
        {
          category: "pull-request-policy",
          effect: "restriction",
          text: "Use the source branch as the target branch.",
          sourceIds: ["src-manifest"],
          factIds: ["fact-branch"],
        },
      ],
    },
  };
  expect(() => analyzeAxisOnboarding(scopeConfusion)).toThrow(AxisOnboardingAnalysisError);
});

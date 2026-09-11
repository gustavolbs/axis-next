// @effect-diagnostics nodeBuiltinImport:off - candidate identifiers are deterministic hashes.
import * as NodeCrypto from "node:crypto";

import * as Schema from "effect/Schema";

import type {
  AxisContextProjectScope,
  AxisProjectRule,
  AxisProjectRuleCategory,
} from "../../../../../packages/contracts/src/axisProjectProfile.ts";
import {
  AxisContextProjectScope as AxisContextProjectScopeSchema,
  AxisProjectRuleCategory as AxisProjectRuleCategorySchema,
} from "../../../../../packages/contracts/src/axisProjectProfile.ts";
import type {
  AxisOnboardingCandidateRule,
  AxisOnboardingConflict,
  AxisOnboardingFact,
  AxisOnboardingSource,
  AxisOnboardingSourceId,
} from "../../../../../packages/contracts/src/axisOnboarding.ts";
import {
  AxisOnboardingCandidateRuleId,
  AxisOnboardingConflictId,
  AxisOnboardingFactId,
  AxisOnboardingSourceId as AxisOnboardingSourceIdSchema,
  AxisOnboardingCandidateRule as AxisOnboardingCandidateRuleSchema,
} from "../../../../../packages/contracts/src/axisOnboarding.ts";
import type { AxisEffectiveContextResult } from "../projects/AxisEffectiveContext.ts";

const isScope = Schema.is(AxisContextProjectScopeSchema);
const isRuleCategory = Schema.is(AxisProjectRuleCategorySchema);
const isSourceId = Schema.is(AxisOnboardingSourceIdSchema);
const isFactId = Schema.is(AxisOnboardingFactId);
const isCandidateRule = Schema.is(AxisOnboardingCandidateRuleSchema);
const candidateEffects = new Set(["restriction", "preference", "default"]);

/** An O02 source with its bounded content. Content is input evidence, never active policy. */
export type AxisOnboardingAnalysisSource = AxisOnboardingSource & {
  readonly content: string | null;
};

export interface AxisOnboardingCandidateDraft {
  readonly category: AxisProjectRuleCategory;
  readonly text: string;
  readonly effect: AxisOnboardingCandidateRule["effect"];
  readonly sourceIds: ReadonlyArray<AxisOnboardingSourceId>;
  readonly factIds: ReadonlyArray<AxisOnboardingFact["id"]>;
}

/** The only model payload accepted by this boundary. It has no operation or activation field. */
export interface AxisOnboardingProviderOutput {
  readonly scope?: AxisContextProjectScope;
  readonly candidates: ReadonlyArray<AxisOnboardingCandidateDraft>;
}

export interface AxisOnboardingAnalysisInput {
  readonly scope: AxisContextProjectScope;
  readonly sources: ReadonlyArray<AxisOnboardingAnalysisSource>;
  readonly facts: ReadonlyArray<AxisOnboardingFact>;
  readonly effectiveContext: Pick<AxisEffectiveContextResult, "scope" | "rules">;
  readonly modelOutput: unknown;
}

export interface AxisOnboardingBranchAnalysis {
  /** A source branch is observed project data, not a pull-request target policy. */
  readonly sourceFacts: ReadonlyArray<AxisOnboardingFact>;
  /** Target policy remains in the effective context and is never derived from sourceFacts. */
  readonly pullRequestPolicies: ReadonlyArray<AxisProjectRule>;
}

export interface AxisOnboardingAnalysisResult {
  readonly scope: AxisContextProjectScope;
  readonly candidateRules: ReadonlyArray<AxisOnboardingCandidateRule>;
  readonly conflicts: ReadonlyArray<AxisOnboardingConflict>;
  readonly branch: AxisOnboardingBranchAnalysis;
}

export type AxisOnboardingAnalysisErrorReason =
  | "invalid_output"
  | "scope_mismatch"
  | "unknown_source"
  | "unreadable_source"
  | "unknown_fact"
  | "missing_evidence"
  | "branch_source_target_confusion"
  | "scope_expansion";

export class AxisOnboardingAnalysisError extends Error {
  readonly reason: AxisOnboardingAnalysisErrorReason;

  constructor(reason: AxisOnboardingAnalysisErrorReason, message: string) {
    super(message);
    this.name = "AxisOnboardingAnalysisError";
    this.reason = reason;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>) => {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const sameScope = (left: AxisContextProjectScope, right: AxisContextProjectScope) =>
  left.contextId === right.contextId &&
  left.project.environmentId === right.project.environmentId &&
  left.project.projectId === right.project.projectId;

const fail = (reason: AxisOnboardingAnalysisErrorReason, message: string): never => {
  throw new AxisOnboardingAnalysisError(reason, message);
};

const digest = (value: string) =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

const candidateId = (candidate: AxisOnboardingCandidateDraft) =>
  AxisOnboardingCandidateRuleId.make(
    `candidate-${digest(
      JSON.stringify({
        category: candidate.category,
        text: candidate.text,
        effect: candidate.effect,
        sourceIds: [...candidate.sourceIds].sort(),
        factIds: [...candidate.factIds].sort(),
      }),
    ).slice(0, 32)}`,
  );

const conflictId = (candidateRuleIds: ReadonlyArray<AxisOnboardingCandidateRuleId>) =>
  AxisOnboardingConflictId.make(
    `conflict-${digest(JSON.stringify([...candidateRuleIds].sort())).slice(0, 32)}`,
  );

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const parseProviderOutput = (raw: unknown): AxisOnboardingProviderOutput => {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return fail("invalid_output", "The onboarding provider returned invalid JSON.");
    }
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ["scope", "candidates"])) {
    return fail("invalid_output", "The onboarding provider returned an unsupported payload.");
  }
  if (value.scope !== undefined && !isScope(value.scope)) {
    return fail("invalid_output", "The onboarding provider returned an invalid scope.");
  }
  if (!Array.isArray(value.candidates) || value.candidates.length > 500) {
    return fail("invalid_output", "The onboarding provider must return a bounded candidate array.");
  }

  const candidates: AxisOnboardingCandidateDraft[] = [];
  for (const candidate of value.candidates) {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, ["category", "text", "effect", "sourceIds", "factIds"])
    ) {
      return fail("invalid_output", "The onboarding provider returned an invalid candidate.");
    }
    if (!isRuleCategory(candidate.category)) {
      return fail("invalid_output", "The onboarding provider returned an invalid rule category.");
    }
    if (
      typeof candidate.text !== "string" ||
      candidate.text.trim().length === 0 ||
      candidate.text.trim().length > 8_000
    ) {
      return fail("invalid_output", "The onboarding provider returned invalid candidate text.");
    }
    if (!candidateEffects.has(candidate.effect as string)) {
      return fail("invalid_output", "The onboarding provider returned an invalid rule effect.");
    }
    if (
      !isStringArray(candidate.sourceIds) ||
      candidate.sourceIds.length === 0 ||
      candidate.sourceIds.length > 100
    ) {
      return fail("invalid_output", "Every candidate must contain source references.");
    }
    if (!isStringArray(candidate.factIds) || candidate.factIds.length > 100) {
      return fail("invalid_output", "The onboarding provider returned invalid fact references.");
    }
    if (
      new Set(candidate.sourceIds).size !== candidate.sourceIds.length ||
      new Set(candidate.factIds).size !== candidate.factIds.length ||
      candidate.sourceIds.some((id) => !isSourceId(id)) ||
      candidate.factIds.some((id) => !isFactId(id))
    ) {
      return fail("invalid_output", "Candidate references must be unique and well formed.");
    }
    candidates.push({
      category: candidate.category,
      text: candidate.text.trim(),
      effect: candidate.effect as AxisOnboardingCandidateRule["effect"],
      sourceIds: candidate.sourceIds as ReadonlyArray<AxisOnboardingSourceId>,
      factIds: candidate.factIds as ReadonlyArray<AxisOnboardingFact["id"]>,
    });
  }
  return {
    ...(value.scope === undefined ? {} : { scope: value.scope as AxisContextProjectScope }),
    candidates,
  };
};

const toCandidateRule = (draft: AxisOnboardingCandidateDraft): AxisOnboardingCandidateRule => {
  const candidate = {
    id: candidateId(draft),
    category: draft.category,
    text: draft.text,
    effect: draft.effect,
    sourceIds: [...draft.sourceIds].sort(),
    factIds: [...draft.factIds].sort(),
  } satisfies AxisOnboardingCandidateRule;
  if (!isCandidateRule(candidate)) {
    return fail("invalid_output", "The onboarding candidate failed contract validation.");
  }
  return candidate;
};

const branchSourceKeys = new Set([
  "branch.source",
  "git.branch",
  "git.source-branch",
  "pull-request.source",
  "pull-request.source-branch",
]);

const branchTargetPattern = /\b(?:target|base|destination)\b/i;

const isBranchSourceFact = (fact: AxisOnboardingFact) =>
  branchSourceKeys.has(fact.key.toLocaleLowerCase("en-US"));

const hasScopeExpansion = (text: string) =>
  /(?:\b(?:outside|another|other|entire|whole)\s+(?:project|repository|workspace|scope)\b|\b(?:all|every|any)\s+(?:projects?|repositories?|workspaces?)\b|\b(?:across|for)\s+(?:all|every|multiple)\s+(?:projects?|repositories?|workspaces?)\b)/i.test(
    text,
  );

const isReadableSource = (
  source: AxisOnboardingAnalysisSource | undefined,
): source is AxisOnboardingAnalysisSource & { readonly status: "read"; readonly content: string } =>
  source?.status === "read" && source.content !== null && source.content.trim().length > 0;

const validateCandidateEvidence = (
  candidate: AxisOnboardingCandidateDraft | AxisOnboardingCandidateRule,
  sourcesById: ReadonlyMap<AxisOnboardingSourceId, AxisOnboardingAnalysisSource>,
  factsById: ReadonlyMap<AxisOnboardingFact["id"], AxisOnboardingFact>,
): void => {
  if (candidate.sourceIds.some((id) => !sourcesById.has(id))) {
    return fail("unknown_source", "The onboarding provider referenced an unknown source.");
  }
  if (candidate.sourceIds.some((id) => !isReadableSource(sourcesById.get(id)))) {
    return fail("unreadable_source", "Candidates may reference only readable source evidence.");
  }
  if (candidate.factIds.some((id) => !factsById.has(id))) {
    return fail("unknown_fact", "The onboarding provider referenced an unknown fact.");
  }
  if (candidate.factIds.some((id) => !candidate.sourceIds.includes(factsById.get(id)!.sourceId))) {
    return fail("missing_evidence", "Every fact reference must belong to a cited source.");
  }
  if (candidate.factIds.length === 0 && candidate.sourceIds.length === 0) {
    return fail("missing_evidence", "A candidate must contain traceable evidence.");
  }
  if (hasScopeExpansion(candidate.text)) {
    return fail("scope_expansion", "Provider content cannot expand the onboarding project scope.");
  }
  if (
    candidate.category === "pull-request-policy" &&
    candidate.factIds.some((id) => isBranchSourceFact(factsById.get(id)!)) &&
    branchTargetPattern.test(candidate.text)
  ) {
    return fail(
      "branch_source_target_confusion",
      "A source branch fact cannot become a pull-request target policy.",
    );
  }
};

const normalizedCommand = (command: string) =>
  command.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");

const mentionsCommand = (content: string, command: string) =>
  normalizedCommand(content).includes(normalizedCommand(command));

const isStaleTestCoverageInstruction = (
  content: string,
  testFacts: ReadonlyArray<AxisOnboardingFact>,
  coverageFacts: ReadonlyArray<AxisOnboardingFact>,
) => {
  if (!/\btest\b[\s\S]{0,160}\b(?:coverage|--coverage)\b/i.test(content)) return false;
  return !testFacts.some((test) =>
    coverageFacts.some(
      (coverage) =>
        coverage.value !== test.value &&
        mentionsCommand(content, test.value) &&
        mentionsCommand(content, coverage.value),
    ),
  );
};

const detectTestCoverageDrift = (
  sources: ReadonlyArray<AxisOnboardingAnalysisSource>,
  facts: ReadonlyArray<AxisOnboardingFact>,
  candidates: AxisOnboardingCandidateRule[],
): AxisOnboardingConflict | null => {
  const testFacts = facts.filter((fact) => fact.key === "script.test");
  const coverageFacts = facts.filter((fact) => fact.key === "script.test:coverage");
  if (testFacts.length === 0 || coverageFacts.length === 0) return null;
  const distinctCommands = testFacts.some((test) =>
    coverageFacts.some((coverage) => coverage.value !== test.value),
  );
  if (!distinctCommands) return null;

  const instruction = sources.find(
    (source) =>
      source.kind === "instruction" &&
      isReadableSource(source) &&
      isStaleTestCoverageInstruction(source.content, testFacts, coverageFacts),
  );
  if (instruction === undefined) return null;

  const evidenceFacts = [...testFacts, ...coverageFacts].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const evidenceSourceIds = [...new Set(evidenceFacts.map((fact) => fact.sourceId))].sort();
  if (
    evidenceSourceIds.some((id) => !isReadableSource(sources.find((source) => source.id === id)))
  ) {
    return null;
  }

  const instructionCandidate =
    candidates.find(
      (candidate) =>
        candidate.category === "test-policy" &&
        candidate.sourceIds.includes(instruction.id) &&
        candidate.factIds.some((id) => evidenceFacts.some((fact) => fact.id === id)),
    ) ??
    toCandidateRule({
      category: "test-policy",
      effect: "preference",
      text: "The instruction combines test and coverage, while the cited project facts record distinct scripts.",
      sourceIds: [instruction.id, ...evidenceSourceIds],
      factIds: evidenceFacts.map((fact) => fact.id),
    });
  if (!candidates.some((candidate) => candidate.id === instructionCandidate.id)) {
    candidates.push(instructionCandidate);
  }

  const factCandidate = toCandidateRule({
    category: "test-policy",
    effect: "preference",
    text: "Use the distinct test and coverage scripts recorded in the cited project facts.",
    sourceIds: evidenceSourceIds,
    factIds: evidenceFacts.map((fact) => fact.id),
  });
  if (!candidates.some((candidate) => candidate.id === factCandidate.id))
    candidates.push(factCandidate);
  if (instructionCandidate.id === factCandidate.id) return null;

  return {
    id: conflictId([instructionCandidate.id, factCandidate.id]),
    candidateRuleIds: [instructionCandidate.id, factCandidate.id].sort(),
    description: `Instruction ${instruction.path} differs from the manifest facts ${evidenceFacts.map((fact) => fact.id).join(", ")}; test and test:coverage are separate commands.`,
  };
};

/** Validates untrusted provider content and returns reviewable, inactive candidates. */
export const analyzeAxisOnboarding = (
  input: AxisOnboardingAnalysisInput,
): AxisOnboardingAnalysisResult => {
  if (
    !isScope(input.scope) ||
    !isScope(input.effectiveContext.scope) ||
    !sameScope(input.scope, input.effectiveContext.scope)
  ) {
    return fail(
      "scope_mismatch",
      "The onboarding scope does not match the effective project context.",
    );
  }
  const output = parseProviderOutput(input.modelOutput);
  if (output.scope !== undefined && !sameScope(input.scope, output.scope)) {
    return fail("scope_mismatch", "The onboarding provider returned a different project scope.");
  }

  const sourcesById = new Map(input.sources.map((source) => [source.id, source]));
  if (sourcesById.size !== input.sources.length) {
    return fail("invalid_output", "Onboarding sources must have unique identifiers.");
  }
  const factsById = new Map(input.facts.map((fact) => [fact.id, fact]));
  if (factsById.size !== input.facts.length) {
    return fail("invalid_output", "Onboarding facts must have unique identifiers.");
  }

  const candidates: AxisOnboardingCandidateRule[] = [];
  const candidateKeys = new Set<string>();
  for (const draft of output.candidates) {
    validateCandidateEvidence(draft, sourcesById, factsById);
    const candidate = toCandidateRule(draft);
    const key = JSON.stringify(candidate);
    if (candidateKeys.has(key))
      return fail("invalid_output", "The onboarding provider returned duplicate candidates.");
    candidateKeys.add(key);
    candidates.push(candidate);
  }

  const branch: AxisOnboardingBranchAnalysis = {
    sourceFacts: input.facts
      .filter(isBranchSourceFact)
      .toSorted((left, right) => left.id.localeCompare(right.id)),
    pullRequestPolicies: input.effectiveContext.rules
      .filter((rule) => rule.category === "pull-request-policy")
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  };
  const conflicts: AxisOnboardingConflict[] = [];
  const testCoverageConflict = detectTestCoverageDrift(input.sources, input.facts, candidates);
  for (const candidate of candidates) {
    validateCandidateEvidence(candidate, sourcesById, factsById);
  }
  if (testCoverageConflict !== null) conflicts.push(testCoverageConflict);

  return {
    scope: input.scope,
    candidateRules: candidates.toSorted((left, right) => left.id.localeCompare(right.id)),
    conflicts: conflicts.toSorted((left, right) => left.id.localeCompare(right.id)),
    branch,
  };
};

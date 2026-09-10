import type { AxisLearningEngineCandidateProposal } from "../../../../../packages/contracts/src/axisLearningEngine.ts";
import type {
  AxisLearningEvidence,
  AxisLearningProposal,
} from "../../../../../packages/contracts/src/axisLearning.ts";
import type {
  AxisProjectProfileSource,
  AxisProjectRule,
} from "../../../../../packages/contracts/src/axisProjectProfile.ts";

export type AxisLearningEvaluationStatus = "accepted-for-review" | "rejected" | "no-change";

export type AxisLearningEvaluationPreviousDecision = Pick<
  AxisLearningProposal,
  | "contextId"
  | "scope"
  | "kind"
  | "targetKey"
  | "targetProvider"
  | "evidenceIds"
  | "change"
  | "status"
>;

export interface AxisLearningEvaluationInput {
  readonly candidate: AxisLearningEngineCandidateProposal;
  readonly sources: ReadonlyArray<AxisProjectProfileSource>;
  readonly rules: ReadonlyArray<AxisProjectRule>;
  readonly examples: ReadonlyArray<AxisLearningEvidence>;
  readonly previousDecisions: ReadonlyArray<AxisLearningEvaluationPreviousDecision>;
}

export interface AxisLearningEvaluationResult {
  readonly status: AxisLearningEvaluationStatus;
  readonly reason: string;
  readonly candidate: AxisLearningEngineCandidateProposal;
}

const normalize = (value: string) => value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ");

const candidateText = (candidate: AxisLearningEngineCandidateProposal) =>
  normalize(
    JSON.stringify({
      kind: candidate.kind,
      targetKey: candidate.targetKey,
      targetProvider: candidate.targetProvider,
      title: candidate.title,
      rationale: candidate.rationale,
      change: candidate.change,
    }),
  );

const sameScope = (
  left: AxisLearningEngineCandidateProposal,
  right: AxisLearningEvaluationPreviousDecision,
) =>
  left.contextId === right.contextId &&
  left.scope?.project?.environmentId === right.scope?.project?.environmentId &&
  left.scope?.project?.projectId === right.scope?.project?.projectId;

const sameCandidate = (
  candidate: AxisLearningEngineCandidateProposal,
  previous: AxisLearningEvaluationPreviousDecision,
) =>
  sameScope(candidate, previous) &&
  candidate.kind === previous.kind &&
  candidate.targetKey === previous.targetKey &&
  candidate.targetProvider?.environmentId === previous.targetProvider?.environmentId &&
  candidate.targetProvider?.instanceId === previous.targetProvider?.instanceId &&
  JSON.stringify(candidate.change) === JSON.stringify(previous.change);

const hasNewEvidence = (
  candidate: AxisLearningEngineCandidateProposal,
  previous: AxisLearningEvaluationPreviousDecision,
) => candidate.evidenceIds.some((id) => !previous.evidenceIds.includes(id));

const meaningfulTerms = (value: string) =>
  normalize(value)
    .split(" ")
    .filter(
      (term) =>
        term.length > 2 && !new Set(["the", "and", "for", "use", "must", "only", "with"]).has(term),
    );

const contradictsExplicitRule = (
  candidate: AxisLearningEngineCandidateProposal,
  rule: AxisProjectRule,
) => {
  if (rule.strength !== "explicit" || rule.effect !== "restriction") return false;

  const restriction = `${rule.text} ${rule.restriction ?? ""}`;
  const text = candidateText(candidate);
  const terms = meaningfulTerms(restriction);
  const negated =
    /\b(do not|don't|never|must not|cannot|can not|prohibited|forbidden|forbid|disable|disabled|only)\b/i.test(
      restriction,
    );
  if (!negated || terms.length === 0) return false;

  const commands =
    restriction.match(/\b(?:npm|pnpm|yarn|bun|npx|node|deno|git)\b[^\s,.;)]*/gi) ?? [];
  if (commands.some((command) => text.includes(normalize(command)))) return true;

  const sharedTerms = [...new Set(terms)].filter((term) => text.includes(term));
  if (sharedTerms.length >= Math.min(2, terms.length)) return true;

  const commandOnly = /\bonly\b/i.test(restriction);
  return (
    commandOnly &&
    commands.length > 0 &&
    commands.every((command) => !text.includes(normalize(command)))
  );
};

const expandsAuthority = (candidate: AxisLearningEngineCandidateProposal) => {
  const text = candidateText(candidate);
  const authorityExpansion =
    /\b(enable|activate|grant|allow|authorize|permit|broaden|expand|widen|add)\b.{0,48}\b(access|permission|permissions|capability|capabilities|mcp|connector|tool|command)\b/i;
  const configurationCommand =
    /(?:--config\b|\b(?:edit|write|change|modify|set)\b.{0,32}\b(?:settings?\.json|config(?:uration)?|permissions?|capabilit(?:y|ies)|mcp)\b|\b(?:enable|install|register)\b.{0,32}\b(?:mcp|connector|tool|capabilit(?:y|ies))\b)/i;
  return authorityExpansion.test(text) || configurationCommand.test(text);
};

const result = (
  status: AxisLearningEvaluationStatus,
  reason: string,
  candidate: AxisLearningEngineCandidateProposal,
): AxisLearningEvaluationResult => ({ status, reason, candidate });

export const evaluateAxisLearningProposal = ({
  candidate,
  sources: _sources,
  rules,
  examples,
  previousDecisions,
}: AxisLearningEvaluationInput): AxisLearningEvaluationResult => {
  if (candidate.evidenceIds.some((id) => !examples.some((example) => example.id === id))) {
    return result(
      "rejected",
      "Candidate evidence must be present in the supplied examples.",
      candidate,
    );
  }

  const conflictingRule = rules.find((rule) => contradictsExplicitRule(candidate, rule));
  if (conflictingRule !== undefined) {
    return result(
      "rejected",
      `Candidate contradicts explicit rule ${conflictingRule.id}.`,
      candidate,
    );
  }

  if (expandsAuthority(candidate)) {
    return result(
      "rejected",
      "Learning cannot expand capabilities, permissions, or configuration commands.",
      candidate,
    );
  }

  const rejectedMatch = previousDecisions.find(
    (previous) => previous.status === "rejected" && sameCandidate(candidate, previous),
  );
  if (rejectedMatch !== undefined && !hasNewEvidence(candidate, rejectedMatch)) {
    return result(
      "rejected",
      "The same rejected content requires new evidence before resubmission.",
      candidate,
    );
  }

  if (
    previousDecisions.some(
      (previous) => previous.status !== "rejected" && sameCandidate(candidate, previous),
    )
  ) {
    return result("no-change", "The same proposal has already been evaluated.", candidate);
  }

  return result(
    "accepted-for-review",
    "Candidate passed deterministic policy checks and requires user review.",
    candidate,
  );
};

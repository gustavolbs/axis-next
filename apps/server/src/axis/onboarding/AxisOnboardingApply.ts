import * as Schema from "effect/Schema";

import {
  AxisOnboardingRun,
  type AxisOnboardingCandidateRule,
  type AxisOnboardingDecision,
  type AxisOnboardingRun as AxisOnboardingRunType,
} from "../../../../../packages/contracts/src/axisOnboarding.ts";
import {
  AxisProjectProfile,
  AxisProjectProfileSourceId,
  AxisProjectRuleId,
  type AxisProjectProfile as AxisProjectProfileType,
  type AxisProjectFact,
  type AxisProjectProfileSource,
  type AxisProjectRule,
} from "../../../../../packages/contracts/src/axisProjectProfile.ts";

export type AxisOnboardingApplyErrorReason =
  | "invalid_run"
  | "scope_mismatch"
  | "profile_conflict"
  | "run_not_complete"
  | "invalid_decision";

export class AxisOnboardingApplyError extends Error {
  readonly reason: AxisOnboardingApplyErrorReason;

  constructor(reason: AxisOnboardingApplyErrorReason, message: string) {
    super(message);
    this.name = "AxisOnboardingApplyError";
    this.reason = reason;
  }
}

export interface AxisOnboardingApplyInput {
  readonly profile: AxisProjectProfileType;
  readonly run: AxisOnboardingRunType;
  readonly decisions: ReadonlyArray<AxisOnboardingDecision>;
  readonly expectedProfileRevision: number;
  readonly decidedAt: string;
}

export interface AxisOnboardingApplyResult {
  readonly profile: AxisProjectProfileType;
  readonly invalidatedRuleIds: ReadonlyArray<AxisProjectRuleId>;
  readonly acceptedCandidateIds: ReadonlyArray<AxisOnboardingCandidateRule["id"]>;
}

type AxisProjectValueFact = {
  readonly kind: "value";
  readonly key: string;
  readonly value: string;
  readonly sourceRef: AxisProjectProfileSource["id"];
};

const isRun = Schema.is(AxisOnboardingRun);
const isProfile = Schema.is(AxisProjectProfile);
const isValueFact = (
  fact: AxisProjectFact,
): fact is Extract<AxisProjectFact, { readonly kind: "value" }> => fact.kind === "value";

const sameScope = (left: AxisProjectProfileType["scope"], right: AxisOnboardingRunType["scope"]) =>
  left.contextId === right.contextId &&
  left.project.environmentId === right.project.environmentId &&
  left.project.projectId === right.project.projectId;

const sourceRef = (sourceId: string) => AxisProjectProfileSourceId.make(`onboarding-${sourceId}`);
const ruleId = (candidateId: string) => AxisProjectRuleId.make(`onboarding-${candidateId}`);

const sourceKind = (
  kind: AxisOnboardingRunType["sources"][number]["kind"],
): AxisProjectProfileSource["kind"] => kind;

const sourceFor = (
  run: AxisOnboardingRunType,
  source: AxisOnboardingRunType["sources"][number],
): AxisProjectProfileSource => {
  const digest = run.digests.find((candidate) => candidate.sourceId === source.id);
  if (source.status !== "read" || digest === undefined) {
    throw new AxisOnboardingApplyError(
      "invalid_run",
      `Onboarding source ${source.path} has no readable digest.`,
    );
  }
  return {
    id: sourceRef(source.id),
    kind: sourceKind(source.kind),
    path: source.path,
    digest: digest.value,
    observedAt: digest.observedAt,
  };
};

const ruleFor = (
  candidate: AxisOnboardingCandidateRule,
  sources: ReadonlyArray<AxisProjectProfileSource>,
  decidedAt: string,
): AxisProjectRule => {
  const source = sources.find((entry) =>
    candidate.sourceIds.some((sourceId) => entry.id === sourceRef(sourceId)),
  );
  if (source === undefined) {
    throw new AxisOnboardingApplyError(
      "invalid_run",
      `Candidate ${candidate.id} has no profile source.`,
    );
  }
  return {
    id: ruleId(candidate.id),
    category: candidate.category,
    text: candidate.text,
    origin: "learning",
    sourceRef: source.id,
    sourceRevision: 1,
    paths: [],
    strength: "explicit",
    effect: candidate.effect,
    restriction: candidate.effect === "restriction" ? candidate.text : null,
    defaultValue: candidate.effect === "default" ? candidate.text : null,
    condition: `Accepted from onboarding at ${decidedAt}.`,
  };
};

/**
 * Converts explicit onboarding decisions into inactive-profile changes.
 * Persistence and optimistic concurrency remain the responsibility of the profile store.
 */
export function applyAxisOnboarding(input: AxisOnboardingApplyInput): AxisOnboardingApplyResult {
  if (!isRun(input.run) || !isProfile(input.profile)) {
    throw new AxisOnboardingApplyError("invalid_run", "The onboarding run or profile is invalid.");
  }
  if (!sameScope(input.profile.scope, input.run.scope)) {
    throw new AxisOnboardingApplyError(
      "scope_mismatch",
      "The onboarding run targets another project.",
    );
  }
  if (input.profile.revision !== input.expectedProfileRevision) {
    throw new AxisOnboardingApplyError(
      "profile_conflict",
      "The project profile changed while onboarding was reviewed.",
    );
  }
  if (input.run.status !== "completed") {
    throw new AxisOnboardingApplyError(
      "run_not_complete",
      "Only a completed onboarding run can be applied.",
    );
  }

  const candidates = new Map(
    input.run.candidateRules.map((candidate) => [candidate.id, candidate]),
  );
  const decisions = new Map<string, AxisOnboardingDecision>();
  const decisionIds = new Set<AxisOnboardingDecision["id"]>();
  for (const decision of input.decisions) {
    if (
      decisions.has(decision.candidateRuleId) ||
      decisionIds.has(decision.id) ||
      !candidates.has(decision.candidateRuleId)
    ) {
      throw new AxisOnboardingApplyError(
        "invalid_decision",
        "Every candidate requires one decision with a unique decision ID.",
      );
    }
    decisions.set(decision.candidateRuleId, decision);
    decisionIds.add(decision.id);
  }
  if (decisions.size !== candidates.size) {
    throw new AxisOnboardingApplyError(
      "invalid_decision",
      "Decide every candidate explicitly; use defer for undecided candidates.",
    );
  }

  const nextSources = input.run.sources
    .filter((source) => source.status === "read")
    .map((source) => sourceFor(input.run, source));
  const sourceByOriginalId = new Map(
    input.run.sources
      .filter((source) => source.status === "read")
      .map((source) => [source.id, sourceRef(source.id)]),
  );
  const previousSources = new Map(input.profile.sources.map((source) => [source.id, source]));
  const changedSourceRefs = new Set(
    nextSources
      .filter((source) => {
        const previous = previousSources.get(source.id);
        return previous !== undefined && previous.digest !== source.digest;
      })
      .map((source) => source.id),
  );

  const revokedRuleIds = new Set(
    input.decisions
      .filter((decision) => decision.decision !== "accept")
      .map((decision) => ruleId(decision.candidateRuleId)),
  );
  const invalidatesRule = (rule: AxisProjectRule) =>
    rule.origin === "learning" &&
    (changedSourceRefs.has(rule.sourceRef) || revokedRuleIds.has(rule.id));
  const invalidatedRuleIds = input.profile.rules.filter(invalidatesRule).map((rule) => rule.id);
  const remainingRules = input.profile.rules.filter((rule) => !invalidatesRule(rule));
  const preservedRuleIds = new Set(
    remainingRules.filter((rule) => rule.origin !== "learning").map((rule) => rule.id),
  );
  const nextFacts: AxisProjectValueFact[] = input.run.facts.map((fact) => {
    const factSourceRef = sourceByOriginalId.get(fact.sourceId);
    if (factSourceRef === undefined || fact.value.length > 2_000) {
      throw new AxisOnboardingApplyError(
        "invalid_run",
        `Onboarding fact ${fact.id} is not representable in a profile.`,
      );
    }
    return { kind: "value", key: fact.key, value: fact.value, sourceRef: factSourceRef };
  });
  const remainingFacts = input.profile.facts.filter(
    (fact) => !isValueFact(fact) || !changedSourceRefs.has(fact.sourceRef),
  );
  const factsToAppend = nextFacts.filter((fact) => {
    for (const existing of remainingFacts) {
      const existingRecord = existing as Record<string, unknown>;
      if (
        existingRecord.key === fact.key &&
        existingRecord.value === fact.value &&
        existingRecord.sourceRef === fact.sourceRef
      ) {
        return false;
      }
    }
    return true;
  });
  const acceptedCandidateIds: AxisOnboardingCandidateRule["id"][] = [];
  const newRules: AxisProjectRule[] = [];
  for (const candidate of input.run.candidateRules) {
    const decision = decisions.get(candidate.id);
    if (decision?.decision !== "accept") continue;
    acceptedCandidateIds.push(candidate.id);
    // Reapplying onboarding must not replace a manual override of its generated rule.
    if (preservedRuleIds.has(ruleId(candidate.id))) continue;
    const candidateWithRefs = {
      ...candidate,
      sourceIds: candidate.sourceIds.filter((id) => sourceByOriginalId.has(id)),
    };
    newRules.push(ruleFor(candidateWithRefs, nextSources, input.decidedAt));
  }

  const manualDecisions = input.run.candidateRules.flatMap((candidate) => {
    const decision = decisions.get(candidate.id);
    return decision === undefined
      ? []
      : [
          {
            id: `onboarding-${decision.id}`,
            question: candidate.text,
            decision: decision.decision,
            note: decision.note,
            decidedAt: input.decidedAt,
          },
        ];
  });
  const nextProfile = {
    ...input.profile,
    sources: [
      ...input.profile.sources.filter(
        (source) => !nextSources.some((next) => next.id === source.id),
      ),
      ...nextSources,
    ],
    facts: [...remainingFacts, ...factsToAppend],
    rules: [
      ...remainingRules.filter((rule) => !newRules.some((next) => next.id === rule.id)),
      ...newRules,
    ],
    manualDecisions: [
      ...input.profile.manualDecisions.filter(
        (decision) => !manualDecisions.some((next) => next.id === decision.id),
      ),
      ...manualDecisions,
    ],
  };
  if (!isProfile(nextProfile)) {
    throw new AxisOnboardingApplyError(
      "invalid_run",
      "The applied onboarding profile failed validation.",
    );
  }
  return {
    profile: nextProfile,
    invalidatedRuleIds,
    acceptedCandidateIds,
  };
}

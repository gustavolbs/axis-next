/**
 * Aggregate-only bridge from token-efficiency diagnostics into Hermes.
 *
 * This module deliberately stops at evidence. It does not create, approve, or
 * activate a learning proposal; an explicit Hermes review still owns that
 * lifecycle. The input is filtered to one Axis context before it crosses the
 * boundary and contains no raw provider payloads.
 */
import {
  AxisContextId,
  AxisLearningEvidenceId,
  type AxisLearningProposalId,
  type AxisLearningProposalDraft,
  type ProviderInstanceId,
  type TokenEfficiencyEngineId,
  type AxisLearningEvidence,
  type TokenEfficiencyHermesObservation,
  type TokenEfficiencySnapshot,
} from "@t3tools/contracts";

export const toHermesObservation = (
  snapshot: TokenEfficiencySnapshot,
  contextId: AxisContextId,
): TokenEfficiencyHermesObservation => ({
  contractVersion: snapshot.contractVersion,
  contextId,
  generatedAt: snapshot.generatedAt,
  baselines: snapshot.baselines.filter((entry) => entry.scope.contextId === contextId),
  aggregates: snapshot.aggregates.filter((entry) => entry.scope.contextId === contextId),
});

const formatNumber = (value: number): string => Math.max(0, Math.floor(value)).toString();

/** Human-readable aggregate evidence; never interpolate a provider payload. */
export const summarizeHermesObservation = (
  observation: TokenEfficiencyHermesObservation,
): string => {
  if (observation.aggregates.length === 0) {
    return "Token-efficiency observation had no context-scoped aggregate samples.";
  }

  return observation.aggregates
    .map((aggregate) => {
      const { scope, metrics, counters, savings } = aggregate;
      const baseline = observation.baselines.find(
        (entry) =>
          entry.scope.provider === scope.provider &&
          entry.scope.providerInstanceId === scope.providerInstanceId &&
          entry.scope.model === scope.model &&
          entry.scope.contextId === scope.contextId,
      );
      return [
        `scope=${scope.provider}/${scope.providerInstanceId}/${scope.model}`,
        `baselineSamples=${formatNumber(baseline?.sampleCount ?? 0)}`,
        `input=${formatNumber(metrics.inputTokens)}`,
        `output=${formatNumber(metrics.outputTokens)}`,
        `cachedInput=${formatNumber(metrics.cachedInputTokens)}`,
        `latencyMs=${formatNumber(metrics.latencyMs)}`,
        `attempts=${formatNumber(counters.attempts)}`,
        `applied=${formatNumber(counters.compressionsApplied)}`,
        `estimatedBefore=${formatNumber(savings.estimatedTokensBefore)}`,
        `estimatedAfter=${formatNumber(savings.estimatedTokensAfter)}`,
      ].join(" ");
    })
    .join("; ");
};

export const makeHermesEvidence = (input: {
  readonly id: string;
  readonly observation: TokenEfficiencyHermesObservation;
  readonly sourceId: string;
  readonly fingerprint: string;
  readonly expiresAt: string;
}): AxisLearningEvidence => ({
  id: AxisLearningEvidenceId.make(input.id),
  provenance: {
    contextId: input.observation.contextId,
    sourceKind: "evaluation",
    sourceId: input.sourceId,
    observedAt: input.observation.generatedAt,
    fingerprint: input.fingerprint,
  },
  summary: summarizeHermesObservation(input.observation),
  createdAt: input.observation.generatedAt,
  expiresAt: input.expiresAt,
});

export interface TokenEfficiencyHermesQualityReview {
  /** The scores must come from a reviewed A/B, not from token estimates. */
  readonly reviewed: boolean;
  readonly controlScore: number;
  readonly candidateScore: number;
}

export interface TokenEfficiencyHermesProposalPolicy {
  readonly proposalId: AxisLearningProposalId;
  readonly evidenceId: AxisLearningEvidenceId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly engine: TokenEfficiencyEngineId;
  readonly model?: string;
  readonly minimumBaselineSamples?: number;
  readonly minimumAppliedCompressions?: number;
  readonly minimumSavingsRate?: number;
  readonly maximumFailureRate?: number;
  readonly minimumQualityScore?: number;
  readonly maximumQualityRegression?: number;
  readonly quality: TokenEfficiencyHermesQualityReview;
}

export type TokenEfficiencyHermesProposalDecision =
  | {
      readonly status: "propose";
      readonly proposal: AxisLearningProposalDraft;
      readonly aggregateModel: string;
      readonly savingsRate: number;
      readonly failureRate: number;
    }
  | {
      readonly status: "rejected";
      readonly reasons: ReadonlyArray<string>;
    };

const DEFAULT_HERMES_PROPOSAL_POLICY = {
  minimumBaselineSamples: 5,
  minimumAppliedCompressions: 5,
  minimumSavingsRate: 0.1,
  maximumFailureRate: 0,
  minimumQualityScore: 0.95,
  maximumQualityRegression: 0.02,
} as const;

const finiteScore = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * Evaluate one context-scoped observation into a draft-only Hermes proposal.
 *
 * This is deliberately a pure adapter. It does not call the learning store,
 * and every rejection is explicit so an external Hermes engine can report why
 * more evidence is needed without weakening the human review boundary.
 */
export const evaluateTokenEfficiencyHermesProposal = (
  observation: TokenEfficiencyHermesObservation,
  policy: TokenEfficiencyHermesProposalPolicy,
): TokenEfficiencyHermesProposalDecision => {
  const resolved = { ...DEFAULT_HERMES_PROPOSAL_POLICY, ...policy };
  const matchingAggregates = observation.aggregates.filter(
    (aggregate) =>
      aggregate.scope.contextId === observation.contextId &&
      aggregate.scope.providerInstanceId === policy.providerInstanceId &&
      (policy.model === undefined || aggregate.scope.model === policy.model),
  );
  const reasons: Array<string> = [];

  if (matchingAggregates.length !== 1) reasons.push("one-unambiguous-provider-model-required");
  if (!policy.quality.reviewed) reasons.push("reviewed-quality-scores-required");
  if (!finiteScore(policy.quality.controlScore) || !finiteScore(policy.quality.candidateScore)) {
    reasons.push("quality-scores-must-be-between-zero-and-one");
  }
  const aggregate = matchingAggregates[0];
  const baseline =
    aggregate === undefined
      ? undefined
      : observation.baselines.find(
          (entry) =>
            entry.scope.provider === aggregate.scope.provider &&
            entry.scope.providerInstanceId === aggregate.scope.providerInstanceId &&
            entry.scope.model === aggregate.scope.model &&
            entry.scope.contextId === aggregate.scope.contextId,
        );
  if ((baseline?.sampleCount ?? 0) < resolved.minimumBaselineSamples) {
    reasons.push("insufficient-control-samples");
  }
  if ((aggregate?.counters.compressionsApplied ?? 0) < resolved.minimumAppliedCompressions) {
    reasons.push("insufficient-applied-compressions");
  }

  const before = aggregate?.savings.estimatedTokensBefore ?? 0;
  const after = aggregate?.savings.estimatedTokensAfter ?? 0;
  const attempts = aggregate?.counters.attempts ?? 0;
  const savingsRate = before > 0 ? Math.max(0, before - after) / before : 0;
  const failureRate = attempts > 0 ? (aggregate?.counters.failures ?? 0) / attempts : 1;
  if (savingsRate < resolved.minimumSavingsRate) reasons.push("estimated-savings-below-minimum");
  if (failureRate > resolved.maximumFailureRate) reasons.push("engine-failure-rate-too-high");

  const qualityDelta = policy.quality.candidateScore - policy.quality.controlScore;
  if (policy.quality.candidateScore < resolved.minimumQualityScore) {
    reasons.push("quality-below-minimum");
  }
  if (qualityDelta < -resolved.maximumQualityRegression) reasons.push("quality-regression");

  if (reasons.length > 0 || aggregate === undefined) {
    return { status: "rejected", reasons };
  }

  const aggregateModel = aggregate.scope.model;
  return {
    status: "propose",
    aggregateModel,
    savingsRate,
    failureRate,
    proposal: {
      id: policy.proposalId,
      contextId: observation.contextId,
      kind: "workflow-recommendation",
      targetKey: `token-efficiency:${policy.providerInstanceId}`,
      title: `Evaluate ${policy.engine} compression for ${policy.providerInstanceId}`,
      rationale: [
        `Reviewed A/B evidence for model ${aggregateModel} in context ${observation.contextId}.`,
        `Estimated savings rate ${(savingsRate * 100).toFixed(1)}% with a ${(failureRate * 100).toFixed(1)}% engine failure rate.`,
        `Quality changed by ${(qualityDelta * 100).toFixed(1)} percentage points against the no-compression control.`,
      ].join(" "),
      evidenceIds: [policy.evidenceId],
      change: {
        kind: "token-efficiency-policy",
        providerInstanceId: policy.providerInstanceId,
        model: aggregateModel,
        engine: policy.engine,
        mode: "compress",
      },
    },
  };
};

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

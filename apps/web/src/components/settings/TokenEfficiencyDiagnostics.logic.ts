import type {
  TokenEfficiencyAggregate,
  TokenEfficiencyBaseline,
  TokenEfficiencyScopeKey,
  TokenEfficiencySnapshot,
} from "@t3tools/contracts";

export interface TokenEfficiencySummary {
  readonly sampleCount: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly toolResultTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly latencyMs: number;
  readonly retries: number;
  readonly billedCostUsd: number | null;
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
  readonly attempts: number;
  readonly compressionsApplied: number;
  readonly passThrough: number;
  readonly netNegative: number;
  readonly failures: number;
}

export interface TokenEfficiencyDiagnosticRow {
  readonly aggregate: TokenEfficiencyAggregate;
  readonly baseline: TokenEfficiencyBaseline | undefined;
  readonly sampleCount: number;
  readonly averageLatencyMs: number | null;
}

export function tokenEfficiencyScopeKey(scope: TokenEfficiencyScopeKey): string {
  return [scope.provider, scope.providerInstanceId, scope.model, scope.contextId ?? ""].join(
    "\u0000",
  );
}

export function summarizeTokenEfficiency(
  snapshot: TokenEfficiencySnapshot | null | undefined,
): TokenEfficiencySummary {
  const summary = {
    sampleCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    toolResultTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    latencyMs: 0,
    retries: 0,
    billedCostUsd: null as number | null,
    estimatedTokensBefore: 0,
    estimatedTokensAfter: 0,
    attempts: 0,
    compressionsApplied: 0,
    passThrough: 0,
    netNegative: 0,
    failures: 0,
  };
  if (!snapshot) return summary;

  for (const baseline of snapshot.baselines) {
    summary.sampleCount += baseline.sampleCount;
    summary.latencyMs += baseline.metrics.latencyMs;
  }
  for (const aggregate of snapshot.aggregates) {
    summary.inputTokens += aggregate.metrics.inputTokens;
    summary.cachedInputTokens += aggregate.metrics.cachedInputTokens;
    summary.toolResultTokens += aggregate.metrics.toolResultTokens;
    summary.outputTokens += aggregate.metrics.outputTokens;
    summary.reasoningTokens += aggregate.metrics.reasoningTokens;
    summary.retries += aggregate.metrics.retries;
    if (aggregate.metrics.billedCostUsd !== null) {
      summary.billedCostUsd = (summary.billedCostUsd ?? 0) + aggregate.metrics.billedCostUsd;
    }
    summary.estimatedTokensBefore += aggregate.savings.estimatedTokensBefore;
    summary.estimatedTokensAfter += aggregate.savings.estimatedTokensAfter;
    summary.attempts += aggregate.counters.attempts;
    summary.compressionsApplied += aggregate.counters.compressionsApplied;
    summary.passThrough += aggregate.counters.passThrough;
    summary.netNegative += aggregate.counters.netNegative;
    summary.failures += aggregate.counters.failures;
  }
  return summary;
}

export function tokenEfficiencyDiagnosticRows(
  snapshot: TokenEfficiencySnapshot | null | undefined,
): ReadonlyArray<TokenEfficiencyDiagnosticRow> {
  if (!snapshot) return [];
  const baselines = new Map(
    snapshot.baselines.map((baseline) => [tokenEfficiencyScopeKey(baseline.scope), baseline]),
  );
  return snapshot.aggregates.map((aggregate) => {
    const baseline = baselines.get(tokenEfficiencyScopeKey(aggregate.scope));
    return {
      aggregate,
      baseline,
      sampleCount: baseline?.sampleCount ?? 0,
      averageLatencyMs:
        baseline && baseline.sampleCount > 0
          ? baseline.metrics.latencyMs / baseline.sampleCount
          : null,
    };
  });
}

/**
 * In-memory, aggregate-only token-efficiency measurements.
 *
 * Provider usage is recorded from normalized runtime events; compaction
 * estimates are kept in a separate savings field. No prompt, tool result, or
 * recovery handle enters this service, which makes its snapshot safe to expose
 * to a diagnostics client or to Hermes as aggregate evidence.
 *
 * @module tokenEfficiency/TokenEfficiencyMetrics
 */
import {
  type AxisContextId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type TokenEfficiencyAggregate,
  type TokenEfficiencyBaseline,
  type TokenEfficiencyCounters,
  type TokenEfficiencyMetrics as TokenEfficiencyMetricValues,
  type TokenEfficiencyMetricAvailability,
  type TokenEfficiencyMode,
  type TokenEfficiencyOutcome,
  type TokenEfficiencyPayloadKind,
  type TokenEfficiencySavings,
  type TokenEfficiencyScopeKey,
  type TokenEfficiencySnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface TokenEfficiencyTurnUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly toolResultTokens?: number;
  readonly billedCostUsd?: number | null;
}

export interface TokenEfficiencyTurnObservation {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly model?: string;
  readonly contextId?: AxisContextId | null;
  readonly usage?: TokenEfficiencyTurnUsage;
  readonly latencyMs?: number;
  readonly retries?: number;
  readonly mode?: TokenEfficiencyMode;
}

export interface TokenEfficiencyCompactionObservation {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly model?: string;
  readonly contextId?: AxisContextId | null;
  readonly payloadKind: TokenEfficiencyPayloadKind;
  readonly outcome: TokenEfficiencyOutcome;
}

export interface TokenEfficiencyMetricsShape {
  readonly recordTurn: (input: TokenEfficiencyTurnObservation) => Effect.Effect<void>;
  readonly recordCompaction: (input: TokenEfficiencyCompactionObservation) => Effect.Effect<void>;
  readonly getSnapshot: Effect.Effect<TokenEfficiencySnapshot>;
  readonly reset: Effect.Effect<void>;
}

export class TokenEfficiencyMetrics extends Context.Service<
  TokenEfficiencyMetrics,
  TokenEfficiencyMetricsShape
>()("t3/tokenEfficiency/TokenEfficiencyMetrics") {}

const emptyMetrics = (): TokenEfficiencyMetricValues => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  toolResultTokens: 0,
  latencyMs: 0,
  retries: 0,
  billedCostUsd: null,
  availability: {
    inputTokens: false,
    cachedInputTokens: false,
    outputTokens: false,
    reasoningTokens: false,
    toolResultTokens: false,
    latencyMs: false,
    retries: false,
    billedCostUsd: false,
  },
});

const emptyCounters = (): TokenEfficiencyCounters => ({
  attempts: 0,
  compressionsApplied: 0,
  passThrough: 0,
  netNegative: 0,
  failures: 0,
});

const emptySavings = (): TokenEfficiencySavings => ({
  estimatedTokensBefore: 0,
  estimatedTokensAfter: 0,
});

const nonNegativeInt = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

const isNonNegativeFinite = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value >= 0;

const normalizedModel = (model: string | undefined): string => {
  const value = model?.trim() ?? "";
  return value.length > 0 ? value : "unknown";
};

const scopeKey = (scope: TokenEfficiencyScopeKey): string =>
  [scope.provider, scope.providerInstanceId, scope.model, scope.contextId ?? ""].join("\u0000");

const makeScope = (input: {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly model?: string;
  readonly contextId?: AxisContextId | null;
}): TokenEfficiencyScopeKey => ({
  provider: input.provider,
  providerInstanceId: input.providerInstanceId,
  model: normalizedModel(input.model),
  contextId: input.contextId ?? null,
});

const addMetricValues = (
  current: TokenEfficiencyMetricValues,
  input: TokenEfficiencyTurnUsage,
  latencyMs: number | undefined,
  retries: number | undefined,
): TokenEfficiencyMetricValues => ({
  inputTokens: current.inputTokens + nonNegativeInt(input.inputTokens),
  cachedInputTokens: current.cachedInputTokens + nonNegativeInt(input.cachedInputTokens),
  outputTokens: current.outputTokens + nonNegativeInt(input.outputTokens),
  reasoningTokens: current.reasoningTokens + nonNegativeInt(input.reasoningTokens),
  toolResultTokens: current.toolResultTokens + nonNegativeInt(input.toolResultTokens),
  latencyMs: current.latencyMs + nonNegativeInt(latencyMs),
  retries: current.retries + nonNegativeInt(retries),
  billedCostUsd:
    input.billedCostUsd !== undefined &&
    input.billedCostUsd !== null &&
    Number.isFinite(input.billedCostUsd) &&
    input.billedCostUsd >= 0
      ? (current.billedCostUsd ?? 0) + input.billedCostUsd
      : current.billedCostUsd,
  availability: addAvailability(current.availability, input, latencyMs, retries),
});

const addAvailability = (
  current: TokenEfficiencyMetricAvailability,
  input: TokenEfficiencyTurnUsage,
  latencyMs: number | undefined,
  retries: number | undefined,
): TokenEfficiencyMetricAvailability => ({
  inputTokens: current.inputTokens || isNonNegativeFinite(input.inputTokens),
  cachedInputTokens: current.cachedInputTokens || isNonNegativeFinite(input.cachedInputTokens),
  outputTokens: current.outputTokens || isNonNegativeFinite(input.outputTokens),
  reasoningTokens: current.reasoningTokens || isNonNegativeFinite(input.reasoningTokens),
  toolResultTokens: current.toolResultTokens || isNonNegativeFinite(input.toolResultTokens),
  latencyMs: current.latencyMs || isNonNegativeFinite(latencyMs),
  retries: current.retries || isNonNegativeFinite(retries),
  billedCostUsd:
    current.billedCostUsd ||
    (input.billedCostUsd !== undefined &&
      input.billedCostUsd !== null &&
      Number.isFinite(input.billedCostUsd) &&
      input.billedCostUsd >= 0),
});

const addCounters = (
  current: TokenEfficiencyCounters,
  outcome: TokenEfficiencyOutcome,
): TokenEfficiencyCounters => {
  const reason = outcome.skippedReason ?? "";
  const failure = reason.startsWith("engine-failed:") || reason === "not-recoverable";
  const netNegative = reason === "no-saving";
  return {
    ...current,
    attempts: current.attempts + 1,
    compressionsApplied: current.compressionsApplied + Number(outcome.applied),
    passThrough: current.passThrough + Number(!outcome.applied && !failure && !netNegative),
    netNegative: current.netNegative + Number(netNegative),
    failures: current.failures + Number(failure),
  };
};

const addSavings = (
  current: TokenEfficiencySavings,
  outcome: TokenEfficiencyOutcome,
): TokenEfficiencySavings =>
  outcome.estimatedTokensAfter < outcome.estimatedTokensBefore
    ? {
        estimatedTokensBefore:
          current.estimatedTokensBefore + nonNegativeInt(outcome.estimatedTokensBefore),
        estimatedTokensAfter:
          current.estimatedTokensAfter + nonNegativeInt(outcome.estimatedTokensAfter),
      }
    : current;

interface MutableAggregate {
  readonly scope: TokenEfficiencyScopeKey;
  metrics: TokenEfficiencyMetricValues;
  counters: TokenEfficiencyCounters;
  savings: TokenEfficiencySavings;
}

interface MutableBaseline {
  readonly scope: TokenEfficiencyScopeKey;
  sampleCount: number;
  metrics: TokenEfficiencyMetricValues;
}

export interface TokenEfficiencyMetricsOptions {
  /** Bounds memory use when a server sees many models or contexts. */
  readonly maxScopes?: number;
  readonly now?: () => string;
}

export const make = (options: TokenEfficiencyMetricsOptions = {}): TokenEfficiencyMetricsShape => {
  const maxScopes = options.maxScopes ?? 2_048;
  const aggregates = new Map<string, MutableAggregate>();
  const baselines = new Map<string, MutableBaseline>();
  const now = options.now ?? (() => DateTime.formatIso(DateTime.nowUnsafe()));

  const getAggregate = (scope: TokenEfficiencyScopeKey): MutableAggregate => {
    const key = scopeKey(scope);
    const existing = aggregates.get(key);
    if (existing) return existing;
    if (aggregates.size >= maxScopes) {
      const oldest = aggregates.keys().next().value;
      if (oldest !== undefined) aggregates.delete(oldest);
    }
    const created: MutableAggregate = {
      scope,
      metrics: emptyMetrics(),
      counters: emptyCounters(),
      savings: emptySavings(),
    };
    aggregates.set(key, created);
    return created;
  };

  const getBaseline = (scope: TokenEfficiencyScopeKey): MutableBaseline => {
    const key = scopeKey(scope);
    const existing = baselines.get(key);
    if (existing) return existing;
    if (baselines.size >= maxScopes) {
      const oldest = baselines.keys().next().value;
      if (oldest !== undefined) baselines.delete(oldest);
    }
    const created: MutableBaseline = { scope, sampleCount: 0, metrics: emptyMetrics() };
    baselines.set(key, created);
    return created;
  };

  const recordTurn: TokenEfficiencyMetricsShape["recordTurn"] = (input) =>
    Effect.sync(() => {
      const scope = makeScope(input);
      const usage = input.usage ?? {};
      const latencyMs = input.latencyMs;
      const retries = input.retries;
      const aggregate = getAggregate(scope);
      aggregate.metrics = addMetricValues(aggregate.metrics, usage, latencyMs, retries);

      // `record` sends the original payload exactly like `off`, so both modes
      // are useful control samples. Compression itself is never called a
      // baseline, even if its provider later reports a low token count.
      if (input.mode !== "compress") {
        const baseline = getBaseline(scope);
        baseline.sampleCount += 1;
        baseline.metrics = addMetricValues(baseline.metrics, usage, latencyMs, retries);
      }
    });

  const recordCompaction: TokenEfficiencyMetricsShape["recordCompaction"] = (input) =>
    Effect.sync(() => {
      const aggregate = getAggregate(makeScope(input));
      aggregate.counters = addCounters(aggregate.counters, input.outcome);
      aggregate.savings = addSavings(aggregate.savings, input.outcome);
    });

  const getSnapshot: TokenEfficiencyMetricsShape["getSnapshot"] = Effect.sync(() => {
    const toBaseline = (entry: MutableBaseline): TokenEfficiencyBaseline => ({
      scope: entry.scope,
      sampleCount: entry.sampleCount,
      metrics: entry.metrics,
    });
    const toAggregate = (entry: MutableAggregate): TokenEfficiencyAggregate => ({
      scope: entry.scope,
      metrics: entry.metrics,
      counters: entry.counters,
      savings: entry.savings,
    });
    return {
      contractVersion: 1,
      generatedAt: now(),
      baselines: Array.from(baselines.values(), toBaseline),
      aggregates: Array.from(aggregates.values(), toAggregate),
    };
  });

  return {
    recordTurn,
    recordCompaction,
    getSnapshot,
    reset: Effect.sync(() => {
      aggregates.clear();
      baselines.clear();
    }),
  };
};

export const layer = Layer.effect(TokenEfficiencyMetrics, Effect.sync(make));

export const layerTest = (options: TokenEfficiencyMetricsOptions = {}) =>
  Layer.succeed(TokenEfficiencyMetrics, make(options));

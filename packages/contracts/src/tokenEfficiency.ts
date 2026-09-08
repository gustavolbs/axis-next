/**
 * Token efficiency — measuring and reducing the tokens a Turn costs without
 * changing what the Turn means.
 *
 * This is a separate runtime concern from the learning layer: nothing here
 * proposes process improvements, and nothing here is allowed to alter intent.
 * The contract exists so compressors (a deterministic compactor, Caveman
 * Engine, LLMLingua-2, …) can be swapped and A/B'd behind one boundary
 * instead of being wired into orchestration.
 *
 * Adoption rule, encoded in the defaults: no compressor ships enabled. `off`
 * is the default everywhere, `record` measures without mutating, and
 * `compress` is opt-in per provider instance.
 *
 * @module tokenEfficiency
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AxisContextId } from "./axisContext.ts";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * What the engine is allowed to do.
 *
 * - `off` — no measurement, no transform. The payload is passed through
 *   untouched and no work is done.
 * - `record` — measure what *would* be saved and report it. The payload is
 *   still passed through untouched. This is the mode an A/B runs in.
 * - `compress` — apply the transform. Only reachable by explicit opt-in.
 */
export const TokenEfficiencyMode = Schema.Literals(["off", "record", "compress"]);
export type TokenEfficiencyMode = typeof TokenEfficiencyMode.Type;

export const DEFAULT_TOKEN_EFFICIENCY_MODE: TokenEfficiencyMode = "off";

/**
 * Names a registered engine implementation. Open slug for the same reason
 * driver kinds are: forks ship their own, and settings written by a build
 * that knows an engine must round-trip through one that does not.
 */
export const TokenEfficiencyEngineId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
).pipe(Schema.brand("TokenEfficiencyEngineId"));
export type TokenEfficiencyEngineId = typeof TokenEfficiencyEngineId.Type;

/** The built-in shape-aware compactor; the only engine that ships today. */
export const DETERMINISTIC_ENGINE_ID = TokenEfficiencyEngineId.make("deterministic");

export const DEFAULT_CONCISE_OUTPUT_ENABLED = false;
export const DEFAULT_CONCISE_OUTPUT_MAX_SENTENCES = 5;
export const DEFAULT_CONCISE_OUTPUT_MAX_BULLETS = 5;

const ConciseOutputMaxSentences = PositiveInt.check(Schema.isBetween({ minimum: 1, maximum: 20 }));
const ConciseOutputMaxBullets = NonNegativeInt.check(Schema.isBetween({ minimum: 0, maximum: 20 }));

/**
 * Provider-owned verbosity limits. The profile is opt-in and does not replace
 * the provider's normal voice, language, or human-facing response style.
 */
export const TokenEfficiencyConciseOutputProfile = Schema.Struct({
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CONCISE_OUTPUT_ENABLED)),
  ),
  maxSentences: ConciseOutputMaxSentences.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CONCISE_OUTPUT_MAX_SENTENCES)),
  ),
  maxBullets: ConciseOutputMaxBullets.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CONCISE_OUTPUT_MAX_BULLETS)),
  ),
});
export type TokenEfficiencyConciseOutputProfile = typeof TokenEfficiencyConciseOutputProfile.Type;

/**
 * Build the provider-owned instruction only for an enabled profile. Returning
 * undefined keeps the default path byte-for-byte free of style instructions.
 */
export function buildConciseOutputInstruction(
  profile: TokenEfficiencyConciseOutputProfile | undefined,
): string | undefined {
  if (profile?.enabled !== true) return undefined;

  return [
    "Respond in your normal provider-owned voice and preserve the user's language.",
    `Keep the response to at most ${profile.maxSentences} sentences.`,
    `Use at most ${profile.maxBullets} bullet points when bullets are useful.`,
  ].join(" ");
}

/**
 * What a payload is, for the purposes of deciding whether it may be touched.
 *
 * The kind is supplied by the caller that owns the payload — the compressor
 * never guesses from content alone, because guessing wrong on a diff or a
 * command is unrecoverable in a way that guessing wrong on a log is not.
 */
export const TokenEfficiencyPayloadKind = Schema.Literals([
  "terminal-output",
  "search-results",
  "accessibility-tree",
  "tool-result",
  "log",
  /** Anything the caller could not classify. Treated as protected. */
  "unknown",
]);
export type TokenEfficiencyPayloadKind = typeof TokenEfficiencyPayloadKind.Type;

const isPayloadKind = Schema.is(TokenEfficiencyPayloadKind);
export const isTokenEfficiencyPayloadKind = (value: unknown): value is TokenEfficiencyPayloadKind =>
  isPayloadKind(value);

/**
 * Per-scope configuration. Absent means inherit: an instance with no entry
 * uses the global default, and a global default of `off` means the feature
 * is inert, which is the shipped state.
 */
export const TokenEfficiencySettings = Schema.Struct({
  mode: Schema.optionalKey(TokenEfficiencyMode),
  engine: Schema.optionalKey(TokenEfficiencyEngineId),
  /**
   * Per-provider-instance override. Rollout is gated here rather than
   * globally so one instance can run an A/B while the rest stay untouched.
   */
  byInstance: Schema.optionalKey(
    Schema.Record(
      ProviderInstanceId,
      Schema.Struct({
        mode: Schema.optionalKey(TokenEfficiencyMode),
        engine: Schema.optionalKey(TokenEfficiencyEngineId),
        conciseOutput: Schema.optionalKey(TokenEfficiencyConciseOutputProfile),
      }),
    ),
  ),
  conciseOutput: Schema.optionalKey(TokenEfficiencyConciseOutputProfile),
});
export type TokenEfficiencySettings = typeof TokenEfficiencySettings.Type;

/**
 * The identity used to merge efficiency observations. `null` is the global
 * context, which keeps provider/model baselines useful before Axis context
 * routing is available. An omitted context also decodes to that value.
 */
export const TokenEfficiencyScopeKey = Schema.Struct({
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  contextId: Schema.NullOr(AxisContextId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type TokenEfficiencyScopeKey = typeof TokenEfficiencyScopeKey.Type;

const NonNegativeFiniteNumber = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
);

/**
 * Additive observations for one scope. Token and latency fields default to
 * zero so a provider can report only the measurements it exposes. A null
 * billed cost means that no provider-reported cost was available.
 */
export const TokenEfficiencyMetrics = Schema.Struct({
  inputTokens: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  cachedInputTokens: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  outputTokens: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  reasoningTokens: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  toolResultTokens: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** Sum of observed wall-clock latency in milliseconds. */
  latencyMs: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** Number of retry attempts beyond the first attempt. */
  retries: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  billedCostUsd: Schema.NullOr(NonNegativeFiniteNumber).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type TokenEfficiencyMetrics = typeof TokenEfficiencyMetrics.Type;

/** Counts kept independent so pass-through and failures cannot hide attempts. */
export const TokenEfficiencyCounters = Schema.Struct({
  attempts: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  compressionsApplied: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  passThrough: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  netNegative: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  failures: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type TokenEfficiencyCounters = typeof TokenEfficiencyCounters.Type;

/** Estimates from the compactor, kept separate from provider-billed usage. */
export const TokenEfficiencySavings = Schema.Struct({
  estimatedTokensBefore: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  estimatedTokensAfter: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type TokenEfficiencySavings = typeof TokenEfficiencySavings.Type;

/** No-compression control measurements for one provider/instance/model/context. */
export const TokenEfficiencyBaseline = Schema.Struct({
  scope: TokenEfficiencyScopeKey,
  sampleCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  metrics: TokenEfficiencyMetrics,
});
export type TokenEfficiencyBaseline = typeof TokenEfficiencyBaseline.Type;

/** Measurements and outcome counters for a candidate efficiency policy. */
export const TokenEfficiencyAggregate = Schema.Struct({
  scope: TokenEfficiencyScopeKey,
  metrics: TokenEfficiencyMetrics,
  counters: TokenEfficiencyCounters,
  savings: TokenEfficiencySavings.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({ estimatedTokensBefore: 0, estimatedTokensAfter: 0 }),
    ),
  ),
});
export type TokenEfficiencyAggregate = typeof TokenEfficiencyAggregate.Type;

export const TOKEN_EFFICIENCY_CONTRACT_VERSION = 1 as const;

/**
 * Wire-safe efficiency report. It contains only aggregate numbers and scope
 * metadata; raw provider/tool text, recovery handles, and payloads have no
 * place in this schema and therefore cannot be sent in a report.
 */
export const TokenEfficiencySnapshot = Schema.Struct({
  contractVersion: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(TOKEN_EFFICIENCY_CONTRACT_VERSION)),
  ),
  generatedAt: IsoDateTime,
  windowStart: Schema.optionalKey(IsoDateTime),
  windowEnd: Schema.optionalKey(IsoDateTime),
  baselines: Schema.Array(TokenEfficiencyBaseline).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  aggregates: Schema.Array(TokenEfficiencyAggregate).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type TokenEfficiencySnapshot = typeof TokenEfficiencySnapshot.Type;

/**
 * Outcome of one compaction attempt, reported in every mode.
 *
 * `applied` is false in `record` mode and whenever the engine declined, so a
 * caller can always use `text` unconditionally: it is the payload to send,
 * transformed or not. `estimatedTokensBefore/After` are estimates, never
 * provider-billed counts — the billed numbers come from the usage layer after
 * the fact, and conflating the two would make an A/B lie.
 */
export interface TokenEfficiencyOutcome {
  readonly text: string;
  readonly applied: boolean;
  readonly engine: TokenEfficiencyEngineId | undefined;
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
  /**
   * Present when the original differs from `text` and was stored, so the
   * original can be recovered while the handle is alive.
   */
  readonly recoveryHandle: string | undefined;
  /**
   * Why nothing was applied. Always set when `applied` is false, so a
   * pass-through is never silent — "compression was net-negative" and
   * "compression crashed" must not look alike in the statistics.
   */
  readonly skippedReason: string | undefined;
}

/**
 * Resolve the mode and engine for one provider instance.
 *
 * Instance settings win over the global default; an instance that names
 * neither inherits both. Unknown engines are *not* resolved here — the
 * registry decides whether it can honor the id, and falls back to
 * pass-through when it cannot.
 */
export function resolveTokenEfficiency(
  settings: TokenEfficiencySettings | undefined,
  instanceId: ProviderInstanceId | undefined,
): { readonly mode: TokenEfficiencyMode; readonly engine: TokenEfficiencyEngineId } {
  const instance = instanceId === undefined ? undefined : settings?.byInstance?.[instanceId];
  return {
    mode: instance?.mode ?? settings?.mode ?? DEFAULT_TOKEN_EFFICIENCY_MODE,
    engine: instance?.engine ?? settings?.engine ?? DETERMINISTIC_ENGINE_ID,
  };
}

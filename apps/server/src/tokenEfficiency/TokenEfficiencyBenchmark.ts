/**
 * Small offline benchmark harness for candidate token-efficiency engines.
 *
 * The harness measures transform cost and estimated savings, but does not
 * claim task-quality equivalence. A caller must provide a quality evaluator
 * for that part of an A/B. Caveman and LLMLingua remain external inputs, so
 * this module never bundles either dependency.
 */
import {
  DETERMINISTIC_ENGINE_ID,
  TokenEfficiencyEngineId,
  type TokenEfficiencyPayloadKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  makeTokenEfficiencyEngine,
  type TokenEfficiencyTransform,
} from "./TokenEfficiencyEngine.ts";
import { compactDeterministically, estimateTokens } from "./deterministicCompaction.ts";
import { makeRecoveryStore } from "./recoveryStore.ts";

export const NO_COMPRESSION_ENGINE_ID = TokenEfficiencyEngineId.make("none");

export interface TokenEfficiencyBenchmarkFixture {
  readonly id: string;
  readonly language: "en" | "pt-BR";
  readonly task: "codex" | "claude" | "work-hub" | "remote-dispatch" | "scheduled-agent";
  readonly kind: Exclude<TokenEfficiencyPayloadKind, "unknown">;
  readonly payload: string;
}

export interface TokenEfficiencyBenchmarkEngine {
  readonly id: TokenEfficiencyEngineId;
  readonly transform: TokenEfficiencyTransform;
}

export interface TokenEfficiencyBenchmarkResult {
  readonly fixtureId: string;
  readonly language: TokenEfficiencyBenchmarkFixture["language"];
  readonly task: TokenEfficiencyBenchmarkFixture["task"];
  readonly engine: TokenEfficiencyEngineId;
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
  readonly elapsedMs: number;
  readonly changed: boolean;
  readonly qualityScore?: number;
}

export interface TokenEfficiencyBenchmarkAcceptancePolicy {
  /** Minimum absolute quality score accepted for a candidate output. */
  readonly minimumQualityScore?: number;
  /** Maximum quality loss against the no-compression control. */
  readonly maximumQualityRegression?: number;
  /** Maximum candidate/control latency ratio. */
  readonly maximumLatencyMultiplier?: number;
  /** Maximum latency allowed when the control completes in zero milliseconds. */
  readonly maximumLatencyOverheadMs?: number;
}

export interface TokenEfficiencyBenchmarkVerdict {
  readonly engine: TokenEfficiencyEngineId;
  readonly accepted: boolean;
  readonly fixtureCount: number;
  readonly evaluatedFixtureCount: number;
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
  readonly estimatedTokensSaved: number;
  readonly meanQualityScore: number | undefined;
  readonly controlMeanQualityScore: number | undefined;
  readonly qualityDelta: number | undefined;
  readonly meanLatencyMs: number;
  readonly controlMeanLatencyMs: number;
  readonly reasons: ReadonlyArray<string>;
}

export interface TokenEfficiencyBenchmarkOptions {
  readonly now?: () => number;
  readonly evaluateQuality?: (input: {
    readonly fixture: TokenEfficiencyBenchmarkFixture;
    readonly output: string;
  }) => number | PromiseLike<number>;
}

const DEFAULT_ACCEPTANCE_POLICY: Required<TokenEfficiencyBenchmarkAcceptancePolicy> = {
  minimumQualityScore: 0.95,
  maximumQualityRegression: 0.02,
  maximumLatencyMultiplier: 2,
  maximumLatencyOverheadMs: 100,
};

const mean = (values: ReadonlyArray<number>): number | undefined =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;

const sum = (values: ReadonlyArray<number>): number =>
  values.reduce((total, value) => total + value, 0);

const validQualityScore = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * Apply the task-quality rollout rule to offline benchmark results.
 *
 * A missing control, missing quality score, invalid score, no estimated
 * saving, or excessive latency rejects the candidate. The function is
 * intentionally pure so a reviewed evaluator can be used in CI without
 * connecting a provider or changing runtime settings.
 */
export const evaluateTokenEfficiencyBenchmark = (
  results: ReadonlyArray<TokenEfficiencyBenchmarkResult>,
  policy: TokenEfficiencyBenchmarkAcceptancePolicy = {},
): ReadonlyArray<TokenEfficiencyBenchmarkVerdict> => {
  const resolved = {
    minimumQualityScore:
      policy.minimumQualityScore ?? DEFAULT_ACCEPTANCE_POLICY.minimumQualityScore,
    maximumQualityRegression:
      policy.maximumQualityRegression ?? DEFAULT_ACCEPTANCE_POLICY.maximumQualityRegression,
    maximumLatencyMultiplier:
      policy.maximumLatencyMultiplier ?? DEFAULT_ACCEPTANCE_POLICY.maximumLatencyMultiplier,
    maximumLatencyOverheadMs:
      policy.maximumLatencyOverheadMs ?? DEFAULT_ACCEPTANCE_POLICY.maximumLatencyOverheadMs,
  };
  const fixtureIds = [...new Set(results.map((result) => result.fixtureId))];
  const controls = new Map(
    results
      .filter((result) => result.engine === NO_COMPRESSION_ENGINE_ID)
      .map((result) => [result.fixtureId, result]),
  );
  const candidates = [...new Set(results.map((result) => result.engine))].filter(
    (engine) => engine !== NO_COMPRESSION_ENGINE_ID,
  );

  return candidates.map((engine) => {
    const candidateResults = results.filter((result) => result.engine === engine);
    const reasons: Array<string> = [];
    const candidateQuality = candidateResults.map((result) => result.qualityScore);
    const controlQuality = fixtureIds.map((fixtureId) => controls.get(fixtureId)?.qualityScore);
    const evaluatedFixtureCount = candidateQuality.filter(validQualityScore).length;
    const candidateBefore = sum(candidateResults.map((result) => result.estimatedTokensBefore));
    const candidateAfter = sum(candidateResults.map((result) => result.estimatedTokensAfter));
    const candidateLatency = mean(candidateResults.map((result) => result.elapsedMs)) ?? 0;
    const controlLatency =
      mean(fixtureIds.map((fixtureId) => controls.get(fixtureId)?.elapsedMs ?? 0)) ?? 0;
    const quality = candidateQuality.every(validQualityScore) ? mean(candidateQuality) : undefined;
    const control = controlQuality.every(validQualityScore) ? mean(controlQuality) : undefined;
    const qualityDelta =
      quality === undefined || control === undefined ? undefined : quality - control;

    if (candidateResults.length !== fixtureIds.length || controls.size !== fixtureIds.length) {
      reasons.push("incomplete-control-or-candidate-results");
    }
    if (quality === undefined || control === undefined) {
      reasons.push("reviewed-quality-scores-required");
    } else {
      if (quality < resolved.minimumQualityScore) reasons.push("quality-below-minimum");
      if (qualityDelta !== undefined && qualityDelta < -resolved.maximumQualityRegression) {
        reasons.push("quality-regression");
      }
    }
    if (candidateAfter >= candidateBefore) reasons.push("no-estimated-token-saving");
    if (
      controlLatency === 0
        ? candidateLatency > resolved.maximumLatencyOverheadMs
        : candidateLatency > controlLatency * resolved.maximumLatencyMultiplier
    ) {
      reasons.push("latency-budget-exceeded");
    }

    return {
      engine,
      accepted: reasons.length === 0,
      fixtureCount: fixtureIds.length,
      evaluatedFixtureCount,
      estimatedTokensBefore: candidateBefore,
      estimatedTokensAfter: candidateAfter,
      estimatedTokensSaved: Math.max(0, candidateBefore - candidateAfter),
      meanQualityScore: quality,
      controlMeanQualityScore: control,
      qualityDelta,
      meanLatencyMs: candidateLatency,
      controlMeanLatencyMs: controlLatency,
      reasons,
    };
  });
};

export const defaultTokenEfficiencyBenchmarkEngines =
  (): ReadonlyArray<TokenEfficiencyBenchmarkEngine> => [
    { id: NO_COMPRESSION_ENGINE_ID, transform: (text) => text },
    { id: DETERMINISTIC_ENGINE_ID, transform: (text) => compactDeterministically(text).text },
  ];

export const runTokenEfficiencyBenchmark = async (
  fixtures: ReadonlyArray<TokenEfficiencyBenchmarkFixture>,
  engines: ReadonlyArray<TokenEfficiencyBenchmarkEngine> = defaultTokenEfficiencyBenchmarkEngines(),
  options: TokenEfficiencyBenchmarkOptions = {},
): Promise<ReadonlyArray<TokenEfficiencyBenchmarkResult>> => {
  // @effect-diagnostics-next-line globalDate:off - benchmarks need a cheap wall-clock sample.
  const now = options.now ?? (() => Date.now());
  const results: Array<TokenEfficiencyBenchmarkResult> = [];

  for (const engineDefinition of engines) {
    const engine = makeTokenEfficiencyEngine({
      transforms: new Map([[engineDefinition.id, engineDefinition.transform]]),
      recoveryStore: makeRecoveryStore(),
    });
    for (const fixture of fixtures) {
      const startedAt = now();
      const outcome = await Effect.runPromise(
        engine.compact({
          text: fixture.payload,
          kind: fixture.kind,
          contextKey: `benchmark:${fixture.id}`,
          mode: "compress",
          engine: engineDefinition.id,
        }),
      );
      const qualityScore = options.evaluateQuality
        ? await options.evaluateQuality({ fixture, output: outcome.text })
        : undefined;
      results.push({
        fixtureId: fixture.id,
        language: fixture.language,
        task: fixture.task,
        engine: engineDefinition.id,
        estimatedTokensBefore: estimateTokens(fixture.payload),
        estimatedTokensAfter: estimateTokens(outcome.text),
        elapsedMs: Math.max(0, now() - startedAt),
        changed: outcome.text !== fixture.payload,
        ...(qualityScore === undefined ? {} : { qualityScore }),
      });
    }
  }

  return results;
};

/** Representative bilingual fixtures kept deliberately free of user data. */
export const TOKEN_EFFICIENCY_BENCHMARK_FIXTURES: ReadonlyArray<TokenEfficiencyBenchmarkFixture> = [
  {
    id: "codex-en-terminal",
    language: "en",
    task: "codex",
    kind: "terminal-output",
    payload: [
      "$ pnpm test",
      "warning: package metadata is stale; see the log for details",
      "warning: package metadata is stale; see the log for details",
      "warning: package metadata is stale; see the log for details",
      "Tests passed",
    ].join("\n"),
  },
  {
    id: "claude-pt-log",
    language: "pt-BR",
    task: "claude",
    kind: "log",
    payload: [
      "iniciando a verificacao",
      "aviso: a dependencia transitiva esta desatualizada",
      "aviso: a dependencia transitiva esta desatualizada",
      "aviso: a dependencia transitiva esta desatualizada",
      "verificacao concluida",
    ].join("\n"),
  },
  {
    id: "work-hub-en-results",
    language: "en",
    task: "work-hub",
    kind: "search-results",
    payload: [
      "result: assigned task is waiting for review",
      "result: assigned task is waiting for review",
      "result: assigned task is waiting for review",
      "result: assigned task is waiting for review",
    ].join("\n"),
  },
  {
    id: "remote-dispatch-pt-tool",
    language: "pt-BR",
    task: "remote-dispatch",
    kind: "tool-result",
    payload: [
      "resultado recebido do ambiente remoto",
      "resultado recebido do ambiente remoto",
      "resultado recebido do ambiente remoto",
      "resultado recebido do ambiente remoto",
    ].join("\n"),
  },
  {
    id: "scheduled-agent-en-accessibility",
    language: "en",
    task: "scheduled-agent",
    kind: "accessibility-tree",
    payload: [
      "button: Refresh dashboard",
      "button: Refresh dashboard",
      "button: Refresh dashboard",
      "status: All systems operational",
    ].join("\n"),
  },
];

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

export interface TokenEfficiencyBenchmarkOptions {
  readonly now?: () => number;
  readonly evaluateQuality?: (input: {
    readonly fixture: TokenEfficiencyBenchmarkFixture;
    readonly output: string;
  }) => number | PromiseLike<number>;
}

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

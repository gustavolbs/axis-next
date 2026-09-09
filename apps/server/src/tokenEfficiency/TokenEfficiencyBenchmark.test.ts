import { describe, expect, it } from "vite-plus/test";

import { DETERMINISTIC_ENGINE_ID, TokenEfficiencyEngineId } from "@t3tools/contracts";
import {
  NO_COMPRESSION_ENGINE_ID,
  TOKEN_EFFICIENCY_BENCHMARK_FIXTURES,
  evaluateTokenEfficiencyBenchmark,
  runTokenEfficiencyBenchmark,
} from "./TokenEfficiencyBenchmark.ts";

describe("runTokenEfficiencyBenchmark", () => {
  it("compares control and deterministic engines across bilingual task fixtures", async () => {
    const results = await runTokenEfficiencyBenchmark(TOKEN_EFFICIENCY_BENCHMARK_FIXTURES);
    expect(results).toHaveLength(TOKEN_EFFICIENCY_BENCHMARK_FIXTURES.length * 2);
    expect(results.filter((result) => result.engine === NO_COMPRESSION_ENGINE_ID)).toHaveLength(5);
    expect(
      results
        .filter((result) => result.engine === DETERMINISTIC_ENGINE_ID)
        .some((result) => result.changed),
    ).toBe(true);
    expect(new Set(results.map((result) => result.language))).toEqual(new Set(["en", "pt-BR"]));
  });

  it("accepts externally installed candidate engines and an explicit quality evaluator", async () => {
    const candidate = TokenEfficiencyEngineId.make("llmlingua-2");
    const [result] = await runTokenEfficiencyBenchmark(
      [TOKEN_EFFICIENCY_BENCHMARK_FIXTURES[0]!],
      [{ id: candidate, transform: () => "short" }],
      {
        now: (() => {
          let value = 100;
          return () => value++;
        })(),
        evaluateQuality: ({ output }) => (output === "short" ? 1 : 0),
      },
    );
    expect(result).toMatchObject({ engine: candidate, qualityScore: 1, changed: true });
  });

  it("accepts a candidate only when quality, savings, and latency pass the control gate", async () => {
    const candidate = TokenEfficiencyEngineId.make("reviewed-candidate");
    const results = await runTokenEfficiencyBenchmark(
      TOKEN_EFFICIENCY_BENCHMARK_FIXTURES.slice(0, 2),
      [
        { id: NO_COMPRESSION_ENGINE_ID, transform: (text) => text },
        { id: candidate, transform: () => "short" },
      ],
      {
        evaluateQuality: ({ fixture, output }) =>
          output === fixture.payload || output === "short" ? 1 : 0,
      },
    );

    expect(evaluateTokenEfficiencyBenchmark(results)).toEqual([
      expect.objectContaining({
        engine: candidate,
        accepted: true,
        fixtureCount: 2,
        evaluatedFixtureCount: 2,
        estimatedTokensSaved: expect.any(Number),
        qualityDelta: 0,
        reasons: [],
      }),
    ]);
  });

  it("rejects missing reviewed quality and incomplete controls", () => {
    const candidate = TokenEfficiencyEngineId.make("unreviewed-candidate");
    const verdicts = evaluateTokenEfficiencyBenchmark([
      {
        fixtureId: "fixture-1",
        language: "en",
        task: "codex",
        engine: NO_COMPRESSION_ENGINE_ID,
        estimatedTokensBefore: 100,
        estimatedTokensAfter: 100,
        elapsedMs: 0,
        changed: false,
      },
      {
        fixtureId: "fixture-1",
        language: "en",
        task: "codex",
        engine: candidate,
        estimatedTokensBefore: 100,
        estimatedTokensAfter: 50,
        elapsedMs: 101,
        changed: true,
      },
    ]);

    expect(verdicts[0]).toMatchObject({
      accepted: false,
      evaluatedFixtureCount: 0,
      reasons: ["reviewed-quality-scores-required", "latency-budget-exceeded"],
    });
  });

  it("rejects a candidate that regresses reviewed task quality", () => {
    const candidate = TokenEfficiencyEngineId.make("low-quality-candidate");
    const verdicts = evaluateTokenEfficiencyBenchmark([
      {
        fixtureId: "fixture-1",
        language: "en",
        task: "codex",
        engine: NO_COMPRESSION_ENGINE_ID,
        estimatedTokensBefore: 100,
        estimatedTokensAfter: 100,
        elapsedMs: 10,
        changed: false,
        qualityScore: 1,
      },
      {
        fixtureId: "fixture-1",
        language: "en",
        task: "codex",
        engine: candidate,
        estimatedTokensBefore: 100,
        estimatedTokensAfter: 50,
        elapsedMs: 10,
        changed: true,
        qualityScore: 0.8,
      },
    ]);

    expect(verdicts[0]).toMatchObject({
      accepted: false,
      qualityDelta: -0.19999999999999996,
      reasons: ["quality-below-minimum", "quality-regression"],
    });
  });
});

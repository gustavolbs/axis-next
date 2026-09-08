import { describe, expect, it } from "vite-plus/test";

import { DETERMINISTIC_ENGINE_ID, TokenEfficiencyEngineId } from "@t3tools/contracts";
import {
  NO_COMPRESSION_ENGINE_ID,
  TOKEN_EFFICIENCY_BENCHMARK_FIXTURES,
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
});

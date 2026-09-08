import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type TokenEfficiencySnapshot,
} from "@t3tools/contracts";

import {
  summarizeTokenEfficiency,
  tokenEfficiencyDiagnosticRows,
} from "./TokenEfficiencyDiagnostics.logic";

const snapshot = (overrides: Partial<TokenEfficiencySnapshot> = {}): TokenEfficiencySnapshot => ({
  contractVersion: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  baselines: [
    {
      scope: {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex-main"),
        model: "gpt-5",
        contextId: null,
      },
      sampleCount: 2,
      metrics: {
        inputTokens: 1_000,
        cachedInputTokens: 400,
        outputTokens: 300,
        reasoningTokens: 100,
        toolResultTokens: 0,
        latencyMs: 800,
        retries: 0,
        billedCostUsd: 0.25,
      },
    },
  ],
  aggregates: [
    {
      scope: {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex-main"),
        model: "gpt-5",
        contextId: null,
      },
      metrics: {
        inputTokens: 1_000,
        cachedInputTokens: 400,
        outputTokens: 300,
        reasoningTokens: 100,
        toolResultTokens: 220,
        latencyMs: 800,
        retries: 2,
        billedCostUsd: 0.25,
      },
      counters: {
        attempts: 3,
        compressionsApplied: 1,
        passThrough: 1,
        netNegative: 1,
        failures: 0,
      },
      savings: { estimatedTokensBefore: 200, estimatedTokensAfter: 120 },
    },
  ],
  ...overrides,
});

describe("summarizeTokenEfficiency", () => {
  it("aggregates savings, usage, latency, cost, and rollout counters", () => {
    expect(summarizeTokenEfficiency(snapshot())).toEqual({
      sampleCount: 2,
      inputTokens: 1_000,
      cachedInputTokens: 400,
      toolResultTokens: 220,
      outputTokens: 300,
      reasoningTokens: 100,
      latencyMs: 800,
      retries: 2,
      billedCostUsd: 0.25,
      estimatedTokensBefore: 200,
      estimatedTokensAfter: 120,
      attempts: 3,
      compressionsApplied: 1,
      passThrough: 1,
      netNegative: 1,
      failures: 0,
    });
  });

  it("does not claim cost availability when no provider reports cost", () => {
    const value = snapshot({
      aggregates: snapshot().aggregates.map((aggregate) => ({
        ...aggregate,
        metrics: { ...aggregate.metrics, billedCostUsd: null },
      })),
    });
    expect(summarizeTokenEfficiency(value).billedCostUsd).toBeNull();
  });
});

it("joins aggregate rows to their matching baseline without mixing models", () => {
  const rows = tokenEfficiencyDiagnosticRows(snapshot());
  expect(rows).toHaveLength(1);
  expect(rows[0]?.sampleCount).toBe(2);
  expect(rows[0]?.averageLatencyMs).toBe(400);
});

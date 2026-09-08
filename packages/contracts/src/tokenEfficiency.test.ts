import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";
import {
  DETERMINISTIC_ENGINE_ID,
  buildConciseOutputInstruction,
  resolveTokenEfficiency,
  TokenEfficiencyAggregate,
  TokenEfficiencyBaseline,
  TokenEfficiencyCounters,
  TokenEfficiencyConciseOutputProfile,
  TokenEfficiencyEngineId,
  TokenEfficiencyMetrics,
  TokenEfficiencyScopeKey,
  TokenEfficiencySavings,
  TokenEfficiencySnapshot,
  TokenEfficiencySettings,
} from "./tokenEfficiency.ts";

const decode = Schema.decodeUnknownSync(TokenEfficiencySettings);
const decodeConciseOutput = Schema.decodeUnknownSync(TokenEfficiencyConciseOutputProfile);
const decodeScope = Schema.decodeUnknownSync(TokenEfficiencyScopeKey);
const encodeScope = Schema.encodeSync(TokenEfficiencyScopeKey);
const decodeMetrics = Schema.decodeUnknownSync(TokenEfficiencyMetrics);
const encodeMetrics = Schema.encodeSync(TokenEfficiencyMetrics);
const decodeCounters = Schema.decodeUnknownSync(TokenEfficiencyCounters);
const decodeBaseline = Schema.decodeUnknownSync(TokenEfficiencyBaseline);
const decodeAggregate = Schema.decodeUnknownSync(TokenEfficiencyAggregate);
const decodeSavings = Schema.decodeUnknownSync(TokenEfficiencySavings);
const decodeSnapshot = Schema.decodeUnknownSync(TokenEfficiencySnapshot);
const encodeSnapshot = Schema.encodeSync(TokenEfficiencySnapshot);
const routemux = ProviderInstanceId.make("routemux_personal");
const claude = ProviderInstanceId.make("claudeAgent");

describe("resolveTokenEfficiency", () => {
  // The adoption rule lives in this default: nothing compresses until someone
  // opts a specific instance in.
  it("is off with no settings at all", () => {
    expect(resolveTokenEfficiency(undefined, routemux)).toEqual({
      mode: "off",
      engine: DETERMINISTIC_ENGINE_ID,
    });
  });

  it("lets one instance run an A/B while the rest stay untouched", () => {
    const settings = decode({
      mode: "off",
      byInstance: { routemux_personal: { mode: "record" } },
    });
    expect(resolveTokenEfficiency(settings, routemux).mode).toBe("record");
    expect(resolveTokenEfficiency(settings, claude).mode).toBe("off");
    expect(resolveTokenEfficiency(settings, undefined).mode).toBe("off");
  });

  it("inherits the engine when an instance overrides only the mode", () => {
    const settings = decode({
      engine: "llmlingua2",
      byInstance: { routemux_personal: { mode: "compress" } },
    });
    expect(resolveTokenEfficiency(settings, routemux)).toEqual({
      mode: "compress",
      engine: TokenEfficiencyEngineId.make("llmlingua2"),
    });
  });

  it("round-trips an engine this build does not ship", () => {
    // Same rule as drivers and gateways: settings written by a build that
    // knows an engine must survive a build that does not.
    expect(decode({ engine: "someForkEngine" }).engine).toBe("someForkEngine");
  });

  it("rejects a mode outside the contract", () => {
    expect(() => decode({ mode: "aggressive" })).toThrow();
  });
});

describe("concise output profile", () => {
  it("round-trips an enabled profile with explicit limits", () => {
    const profile = decodeConciseOutput({ enabled: true, maxSentences: 3, maxBullets: 2 });

    expect(profile).toEqual({ enabled: true, maxSentences: 3, maxBullets: 2 });
    expect(Schema.encodeSync(TokenEfficiencyConciseOutputProfile)(profile)).toEqual(profile);
    expect(
      decode({
        conciseOutput: { enabled: true, maxSentences: 3, maxBullets: 2 },
        byInstance: {
          codex_personal: { conciseOutput: { enabled: false } },
        },
      }).conciseOutput,
    ).toEqual(profile);
  });

  it("defaults optional profile values without enabling the style", () => {
    expect(decodeConciseOutput({})).toEqual({
      enabled: false,
      maxSentences: 5,
      maxBullets: 5,
    });
    expect(buildConciseOutputInstruction(undefined)).toBeUndefined();
    expect(buildConciseOutputInstruction(decodeConciseOutput({}))).toBeUndefined();
  });

  it("builds a bounded provider-owned instruction only when enabled", () => {
    const instruction = buildConciseOutputInstruction(
      decodeConciseOutput({ enabled: true, maxSentences: 2, maxBullets: 0 }),
    );

    expect(instruction).toContain("normal provider-owned voice");
    expect(instruction).toContain("at most 2 sentences");
    expect(instruction).toContain("at most 0 bullet points");
  });

  it("rejects limits outside the explicit profile bounds", () => {
    for (const profile of [
      { enabled: true, maxSentences: 0, maxBullets: 5 },
      { enabled: true, maxSentences: 21, maxBullets: 5 },
      { enabled: true, maxSentences: 5, maxBullets: -1 },
      { enabled: true, maxSentences: 5, maxBullets: 21 },
    ]) {
      expect(() => decodeConciseOutput(profile)).toThrow();
    }
  });
});

describe("token efficiency baselines and statistics", () => {
  it("defaults an omitted context to the global scope and round-trips it", () => {
    const scope = decodeScope({
      provider: "codex",
      providerInstanceId: "codex_personal",
      model: "gpt-5",
    });

    expect(scope.contextId).toBeNull();
    expect(encodeScope(scope)).toEqual({
      provider: "codex",
      providerInstanceId: "codex_personal",
      model: "gpt-5",
      contextId: null,
    });
    expect(decodeScope({ ...scope, contextId: "company_a" }).contextId).toBe("company_a");
  });

  it("defaults additive measurements and independent outcome counters", () => {
    expect(decodeMetrics({})).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      toolResultTokens: 0,
      latencyMs: 0,
      retries: 0,
      billedCostUsd: null,
    });
    expect(decodeCounters({})).toEqual({
      attempts: 0,
      compressionsApplied: 0,
      passThrough: 0,
      netNegative: 0,
      failures: 0,
    });
    expect(decodeSavings({})).toEqual({ estimatedTokensBefore: 0, estimatedTokensAfter: 0 });
  });

  it("encodes and decodes a baseline and an aggregate without losing billing data", () => {
    const scope = {
      provider: "claude",
      providerInstanceId: "claude_work",
      model: "claude-sonnet",
      contextId: null,
    };
    const metrics = {
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 180,
      reasoningTokens: 60,
      toolResultTokens: 220,
      latencyMs: 12_500,
      retries: 2,
      billedCostUsd: 0.37,
    };
    const baseline = decodeBaseline({ scope, sampleCount: 4, metrics });
    const aggregate = decodeAggregate({
      scope,
      metrics,
      counters: {
        attempts: 4,
        compressionsApplied: 2,
        passThrough: 1,
        netNegative: 1,
        failures: 0,
      },
      savings: { estimatedTokensBefore: 100, estimatedTokensAfter: 40 },
    });

    expect(baseline.metrics).toEqual(metrics);
    expect(aggregate.counters.compressionsApplied).toBe(2);
    expect(aggregate.metrics.billedCostUsd).toBe(0.37);
    expect(aggregate.savings.estimatedTokensAfter).toBe(40);
  });

  it("represents unavailable billed cost without inventing a zero charge", () => {
    expect(decodeMetrics({ inputTokens: 10 }).billedCostUsd).toBeNull();
    expect(encodeMetrics(decodeMetrics({ inputTokens: 10 }))).toMatchObject({
      inputTokens: 10,
      billedCostUsd: null,
    });
  });

  it("defaults a minimal snapshot to version one with empty collections", () => {
    expect(decodeSnapshot({ generatedAt: "2026-09-07T12:00:00.000Z" })).toMatchObject({
      contractVersion: 1,
      baselines: [],
      aggregates: [],
    });
    expect(() => decodeSnapshot({ contractVersion: 0, generatedAt: "now" })).toThrow();
  });

  it("rejects invalid scope, measurements, counters, and billed cost", () => {
    expect(() =>
      decodeScope({ provider: "codex", providerInstanceId: " ", model: "gpt-5" }),
    ).toThrow();
    expect(() =>
      decodeScope({
        provider: "codex",
        providerInstanceId: "codex",
        model: "gpt-5",
        contextId: " ",
      }),
    ).toThrow();
    expect(() => decodeMetrics({ inputTokens: -1 })).toThrow();
    expect(() => decodeMetrics({ latencyMs: 1.5 })).toThrow();
    expect(() => decodeMetrics({ billedCostUsd: -0.01 })).toThrow();
    expect(() => decodeMetrics({ billedCostUsd: Number.NaN })).toThrow();
    expect(() => decodeCounters({ failures: -1 })).toThrow();
    expect(() => decodeSavings({ estimatedTokensAfter: -1 })).toThrow();
  });

  it("round-trips a wire-safe snapshot and excludes sensitive payload fields", () => {
    const decoded = decodeSnapshot({
      generatedAt: "2026-09-07T12:00:00.000Z",
      baselines: [
        {
          scope: { provider: "codex", providerInstanceId: "codex_personal", model: "gpt-5" },
          sampleCount: 1,
          metrics: { outputTokens: 12 },
          payload: "secret tool output",
        },
      ],
      aggregates: [
        {
          scope: {
            provider: "codex",
            providerInstanceId: "codex_personal",
            model: "gpt-5",
            contextId: "global",
          },
          counters: { attempts: 1, passThrough: 1 },
          metrics: { outputTokens: 12 },
          recoveryHandle: "sensitive-recovery-handle",
        },
      ],
      payload: "must not cross the wire",
    } as unknown);
    const encoded = encodeSnapshot(decoded);

    expect(decoded.contractVersion).toBe(1);
    expect(encoded).not.toHaveProperty("payload");
    expect(encoded.baselines?.[0]).not.toHaveProperty("payload");
    expect(encoded.aggregates?.[0]).not.toHaveProperty("recoveryHandle");
    expect(encoded.aggregates?.[0]?.scope.contextId).toBe("global");
  });
});

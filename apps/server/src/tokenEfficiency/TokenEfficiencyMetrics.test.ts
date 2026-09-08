import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { make } from "./TokenEfficiencyMetrics.ts";

const turn = (overrides: Partial<Parameters<ReturnType<typeof make>["recordTurn"]>[0]> = {}) => ({
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex-work"),
  model: "gpt-5",
  ...overrides,
});

const outcome = (
  overrides: Partial<{
    applied: boolean;
    skippedReason: string;
    estimatedTokensBefore: number;
    estimatedTokensAfter: number;
  }> = {},
) => ({
  text: "raw provider output that must never be snapshotted",
  applied: false,
  engine: undefined,
  estimatedTokensBefore: 100,
  estimatedTokensAfter: 100,
  recoveryHandle: undefined,
  skippedReason: "protected-kind:unknown",
  ...overrides,
});

describe("TokenEfficiencyMetrics", () => {
  it.effect("keeps off and record as baseline samples, excluding compress", () =>
    Effect.gen(function* () {
      const metrics = make();
      yield* metrics.recordTurn(turn({ mode: "off", usage: { inputTokens: 10 } }));
      yield* metrics.recordTurn(turn({ mode: "record", usage: { inputTokens: 20 } }));
      yield* metrics.recordTurn(turn({ mode: "compress", usage: { inputTokens: 30 } }));

      const snapshot = yield* metrics.getSnapshot;
      expect(snapshot.baselines).toHaveLength(1);
      const baseline = snapshot.baselines[0];
      const aggregate = snapshot.aggregates[0];
      if (!baseline || !aggregate) throw new Error("expected one baseline and aggregate");
      expect(baseline).toMatchObject({ sampleCount: 2, metrics: { inputTokens: 30 } });
      expect(aggregate.metrics.inputTokens).toBe(60);
    }),
  );

  it.effect("aggregates usage, billed cost, latency, and retries", () =>
    Effect.gen(function* () {
      const metrics = make();
      yield* metrics.recordTurn(
        turn({
          usage: {
            inputTokens: 100,
            cachedInputTokens: 12,
            outputTokens: 40,
            reasoningTokens: 8,
            toolResultTokens: 5,
            billedCostUsd: 0.25,
          },
          latencyMs: 1200,
          retries: 1,
        }),
      );
      yield* metrics.recordTurn(
        turn({ usage: { inputTokens: 50, billedCostUsd: 0.1 }, latencyMs: 300, retries: 2 }),
      );

      const aggregate = (yield* metrics.getSnapshot).aggregates[0];
      if (!aggregate) throw new Error("expected aggregate");
      expect(aggregate.metrics).toEqual({
        inputTokens: 150,
        cachedInputTokens: 12,
        outputTokens: 40,
        reasoningTokens: 8,
        toolResultTokens: 5,
        latencyMs: 1500,
        retries: 3,
        billedCostUsd: 0.35,
      });
    }),
  );

  it.effect("counts compaction outcomes and only records real savings", () =>
    Effect.gen(function* () {
      const metrics = make();
      const base = {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex-work"),
        model: "gpt-5",
        payloadKind: "log" as const,
      };
      yield* metrics.recordCompaction({
        ...base,
        outcome: outcome({ applied: true, estimatedTokensAfter: 40 }),
      });
      yield* metrics.recordCompaction({
        ...base,
        outcome: outcome({ skippedReason: "no-saving", estimatedTokensAfter: 120 }),
      });
      yield* metrics.recordCompaction({
        ...base,
        outcome: outcome({ skippedReason: "engine-failed:deterministic" }),
      });
      yield* metrics.recordCompaction({
        ...base,
        outcome: outcome({ skippedReason: "protected-kind:unknown" }),
      });

      const aggregate = (yield* metrics.getSnapshot).aggregates[0];
      if (!aggregate) throw new Error("expected aggregate");
      expect(aggregate.counters).toEqual({
        attempts: 4,
        compressionsApplied: 1,
        passThrough: 1,
        netNegative: 1,
        failures: 1,
      });
      expect(aggregate.savings).toEqual({ estimatedTokensBefore: 100, estimatedTokensAfter: 40 });
    }),
  );

  it.effect("bounds both aggregate and baseline scopes by evicting the oldest", () =>
    Effect.gen(function* () {
      const metrics = make({ maxScopes: 2 });
      for (const model of ["model-a", "model-b", "model-c"]) {
        yield* metrics.recordTurn(turn({ model, usage: { inputTokens: 1 } }));
      }
      const snapshot = yield* metrics.getSnapshot;
      if (snapshot.aggregates.length !== 2 || snapshot.baselines.length !== 2) {
        throw new Error("expected two bounded scopes");
      }
      expect(snapshot.aggregates.map(({ scope }) => scope.model)).toEqual(["model-b", "model-c"]);
      expect(snapshot.baselines.map(({ scope }) => scope.model)).toEqual(["model-b", "model-c"]);
    }),
  );

  it.effect("returns aggregate metadata without raw payloads", () =>
    Effect.gen(function* () {
      const metrics = make({ now: () => "2026-09-07T00:00:00.000Z" });
      yield* metrics.recordTurn(turn({ usage: { inputTokens: 1 } }));
      yield* metrics.recordCompaction({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex-work"),
        model: "gpt-5",
        payloadKind: "tool-result",
        outcome: { ...outcome(), text: "SECRET-RAW-TOOL-OUTPUT", recoveryHandle: "secret-handle" },
      });
      const snapshot = yield* metrics.getSnapshot;
      expect(snapshot.generatedAt).toBe("2026-09-07T00:00:00.000Z");
      expect(Object.hasOwn(snapshot, "payload")).toBe(false);
      expect(Object.hasOwn(snapshot.aggregates[0] ?? {}, "payload")).toBe(false);
      expect(Object.hasOwn(snapshot.aggregates[0] ?? {}, "text")).toBe(false);
      expect(Object.hasOwn(snapshot.aggregates[0] ?? {}, "recoveryHandle")).toBe(false);
      expect(snapshot.aggregates[0]?.savings).toEqual({
        estimatedTokensBefore: 0,
        estimatedTokensAfter: 0,
      });
      expect(snapshot.aggregates[0]?.counters.attempts).toBe(1);
    }),
  );
});

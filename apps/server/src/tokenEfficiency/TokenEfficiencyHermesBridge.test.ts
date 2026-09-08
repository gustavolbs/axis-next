import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  makeHermesEvidence,
  summarizeHermesObservation,
  toHermesObservation,
} from "./TokenEfficiencyHermesBridge.ts";
import { AxisContextId, TokenEfficiencySnapshot } from "@t3tools/contracts";

const snapshot = Schema.decodeUnknownSync(TokenEfficiencySnapshot)({
  contractVersion: 1,
  generatedAt: "2026-09-08T10:00:00.000Z",
  baselines: [
    {
      scope: {
        provider: "codex",
        providerInstanceId: "codex",
        model: "gpt-5",
        contextId: "company_a",
      },
      sampleCount: 2,
      metrics: { inputTokens: 100 },
    },
  ],
  aggregates: [
    {
      scope: {
        provider: "codex",
        providerInstanceId: "codex",
        model: "gpt-5",
        contextId: "company_a",
      },
      metrics: { inputTokens: 80, outputTokens: 20 },
      counters: { attempts: 3, compressionsApplied: 1 },
      savings: { estimatedTokensBefore: 100, estimatedTokensAfter: 60 },
    },
    {
      scope: {
        provider: "codex",
        providerInstanceId: "codex",
        model: "gpt-5",
        contextId: "company_b",
      },
      metrics: { inputTokens: 999 },
      counters: { attempts: 99 },
      savings: { estimatedTokensBefore: 999, estimatedTokensAfter: 1 },
    },
  ],
});

describe("TokenEfficiencyHermesBridge", () => {
  it("filters observations to the requested context", () => {
    const observation = toHermesObservation(snapshot, AxisContextId.make("company_a"));
    expect(observation.aggregates).toHaveLength(1);
    expect(observation.baselines).toHaveLength(1);
    expect(JSON.stringify(observation)).not.toContain("company_b");
  });

  it("emits only aggregate fields in stable evidence", () => {
    const observation = toHermesObservation(snapshot, AxisContextId.make("company_a"));
    const summary = summarizeHermesObservation(observation);
    expect(summary).toContain("estimatedBefore=100");
    expect(summary).not.toContain("prompt");
    const evidence = makeHermesEvidence({
      id: "efficiency-evidence-1",
      observation,
      sourceId: "token-efficiency:company_a",
      fingerprint: "sha256:aggregate-1",
      expiresAt: "2026-10-08T10:00:00.000Z",
    });
    expect(evidence.provenance.sourceKind).toBe("evaluation");
    expect(evidence.summary).toBe(summary);
    expect(evidence).not.toHaveProperty("recoveryHandle");
  });
});

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  evaluateTokenEfficiencyHermesProposal,
  makeHermesEvidence,
  summarizeHermesObservation,
  toHermesObservation,
} from "./TokenEfficiencyHermesBridge.ts";
import {
  AxisContextId,
  AxisLearningEvidenceId,
  AxisLearningProposalId,
  ProviderInstanceId,
  TokenEfficiencyEngineId,
  TokenEfficiencySnapshot,
} from "@t3tools/contracts";

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
const decodeSnapshot = Schema.decodeUnknownSync(TokenEfficiencySnapshot);

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

  it("creates a draft-only proposal after reviewed quality and efficiency gates pass", () => {
    const observation = toHermesObservation(
      decodeSnapshot({
        ...snapshot,
        baselines: [
          {
            ...snapshot.baselines[0]!,
            sampleCount: 5,
          },
        ],
        aggregates: [
          {
            ...snapshot.aggregates[0]!,
            counters: { attempts: 5, compressionsApplied: 5, failures: 0 },
            savings: { estimatedTokensBefore: 1_000, estimatedTokensAfter: 700 },
          },
        ],
      }),
      AxisContextId.make("company_a"),
    );
    const decision = evaluateTokenEfficiencyHermesProposal(observation, {
      proposalId: AxisLearningProposalId.make("proposal-token-efficiency-1"),
      evidenceId: AxisLearningEvidenceId.make("efficiency-evidence-1"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      engine: TokenEfficiencyEngineId.make("deterministic"),
      quality: { reviewed: true, controlScore: 1, candidateScore: 0.99 },
    });

    expect(decision.status).toBe("propose");
    if (decision.status !== "propose") throw new Error("expected a proposal");
    expect(decision.proposal).toMatchObject({
      contextId: "company_a",
      id: AxisLearningProposalId.make("proposal-token-efficiency-1"),
      evidenceIds: ["efficiency-evidence-1"],
      change: {
        kind: "token-efficiency-policy",
        mode: "compress",
        engine: "deterministic",
      },
    });
    expect(JSON.stringify(decision.proposal)).not.toContain("prompt");
  });

  it("rejects Hermes proposals when quality was not reviewed or control evidence is weak", () => {
    const observation = toHermesObservation(snapshot, AxisContextId.make("company_a"));
    const decision = evaluateTokenEfficiencyHermesProposal(observation, {
      proposalId: AxisLearningProposalId.make("proposal-token-efficiency-2"),
      evidenceId: AxisLearningEvidenceId.make("efficiency-evidence-2"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      engine: TokenEfficiencyEngineId.make("deterministic"),
      quality: { reviewed: false, controlScore: 1, candidateScore: 1 },
    });

    expect(decision).toEqual({
      status: "rejected",
      reasons: [
        "reviewed-quality-scores-required",
        "insufficient-control-samples",
        "insufficient-applied-compressions",
      ],
    });
  });
});

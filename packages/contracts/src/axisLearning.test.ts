import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AxisLearningEvidence, AxisLearningProposalDraft } from "./axisLearning.ts";

const decodeEvidence = Schema.decodeUnknownSync(AxisLearningEvidence);
const decodeProposalDraft = Schema.decodeUnknownSync(AxisLearningProposalDraft);

describe("Axis learning contracts", () => {
  it("keeps context and provenance on evidence", () => {
    const evidence = decodeEvidence({
      id: "evidence_1",
      provenance: {
        contextId: "company_a",
        sourceKind: "thread-turn",
        sourceId: "thread-1:turn-1",
        provider: { environmentId: "local", instanceId: "codex_work" },
        observedAt: "2026-09-05T10:00:00.000Z",
        fingerprint: "sha256:abc",
      },
      summary: "The review step caught a missing regression test.",
      createdAt: "2026-09-05T10:01:00.000Z",
      expiresAt: "2026-10-05T10:01:00.000Z",
    });
    expect(evidence.provenance.contextId).toBe("company_a");
    expect(evidence.provenance.provider?.instanceId).toBe("codex_work");
  });

  it("requires evidence for every proposal", () => {
    expect(() =>
      decodeProposalDraft({
        id: "proposal_1",
        contextId: "personal",
        kind: "provider-skill",
        targetKey: "skill:test",
        title: "Improve test skill",
        rationale: "Observed repeated correction.",
        evidenceIds: [],
        change: { op: "replace", path: "instructions", value: "Run focused tests." },
      }),
    ).toThrow();
  });
});

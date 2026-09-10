import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AxisLearningActivationState,
  AxisLearningActiveVersion,
  AxisLearningLifecycleEvent,
  AxisLearningVersion,
  AxisLearningChange,
  AxisLearningEvidence,
  AxisLearningListInput,
  AxisLearningProposalDraft,
  AxisLearningScope,
  axisLearningEvidenceSemanticallyEquals,
  emptyAxisLearningActivationState,
  normalizeAxisLearningActivationState,
} from "./axisLearning.ts";

const decodeEvidence = Schema.decodeUnknownSync(AxisLearningEvidence);
const decodeProposalDraft = Schema.decodeUnknownSync(AxisLearningProposalDraft);
const decodeChange = Schema.decodeUnknownSync(AxisLearningChange);
const decodeListInput = Schema.decodeUnknownSync(AxisLearningListInput);
const decodeActivationState = Schema.decodeUnknownSync(AxisLearningActivationState);
const decodeScope = Schema.decodeUnknownSync(AxisLearningScope);
const decodeVersion = Schema.decodeUnknownSync(AxisLearningVersion);
const decodeLifecycle = Schema.decodeUnknownSync(AxisLearningLifecycleEvent);
const decodeActiveVersion = Schema.decodeUnknownSync(AxisLearningActiveVersion);

describe("Axis learning contracts", () => {
  it("preserves legacy snapshots while rejecting inconsistent record scopes", () => {
    const createdAt = "2026-09-09T10:00:00.000Z";
    const version = {
      id: "version_1",
      proposalId: "proposal_1",
      contextId: "company_a",
      kind: "provider-instructions",
      targetKey: "provider:codex:step:execute",
      title: "Use focused checks",
      rationale: "Keep verification relevant",
      evidenceIds: ["evidence_1"],
      change: { legacy: "Display-only payload" },
      approvedBy: "owner",
      createdAt,
    };
    const lifecycle = {
      id: "event_1",
      contextId: "company_a",
      action: "activated",
      proposalId: "proposal_1",
      versionId: "version_1",
      previousVersionId: null,
      actor: "owner",
      note: null,
      createdAt,
    };
    const activeVersion = {
      contextId: "company_a",
      targetKey: "provider:codex:step:execute",
      versionId: "version_1",
      activatedAt: createdAt,
    };
    for (const [decode, record] of [
      [decodeVersion, version],
      [decodeLifecycle, lifecycle],
      [decodeActiveVersion, activeVersion],
    ] as const) {
      expect(decode(record).scope).toBeUndefined();
      const scope = { contextId: "company_a", project: { environmentId: "env", projectId: "p1" } };
      expect(decode({ ...record, scope }).scope).toEqual(scope);
      expect(() => decode({ ...record, scope: { ...scope, contextId: "company_b" } })).toThrow();
    }
  });

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

  it("requires provenance scope and context to agree", () => {
    expect(() =>
      decodeEvidence({
        id: "evidence_mismatched_scope",
        provenance: {
          contextId: "company_a",
          scope: {
            contextId: "company_b",
            project: { environmentId: "laptop", projectId: "venue-sites" },
          },
          sourceKind: "evaluation",
          sourceId: "run-mismatched-scope",
          observedAt: "2026-09-05T10:00:00.000Z",
          fingerprint: "sha256:mismatched-scope",
        },
        summary: "Mismatched provenance scope must be rejected.",
        createdAt: "2026-09-05T10:01:00.000Z",
        expiresAt: "2026-10-05T10:01:00.000Z",
      }),
    ).toThrow();
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

  it("keeps project scope explicit and leaves old records context-only", () => {
    const legacyInput = decodeListInput({ contextId: "company_a" });
    const projectInput = decodeListInput({
      scope: {
        contextId: "company_a",
        project: { environmentId: "laptop", projectId: "venue-sites" },
      },
    });
    expect(legacyInput.scope).toBeUndefined();
    expect(projectInput).toMatchObject({
      contextId: "company_a",
      scope: { project: { projectId: "venue-sites" } },
    });
  });

  it("wraps unknown legacy changes without making them executable", () => {
    expect(decodeChange({ op: "set-rule", rule: { id: "rule-1" } })).toMatchObject({
      kind: "legacy-unknown",
    });
    expect(decodeChange({ op: "set-provider-instruction", capabilityId: "cap-1" })).toMatchObject({
      kind: "legacy-unknown",
    });
  });

  it("normalizes a missing activation row without rewriting legacy data", () => {
    const scope = decodeScope({ contextId: "company_a" });
    const empty = emptyAxisLearningActivationState(scope, "workflow:test");
    expect(empty).toMatchObject({ versionId: null, revision: 0, updatedAt: null });
    expect(normalizeAxisLearningActivationState(undefined, scope, "workflow:test")).toEqual(empty);
    expect(
      decodeActivationState({
        scope: { contextId: "company_a", project: { environmentId: "laptop", projectId: "p1" } },
        targetKey: "workflow:test",
        versionId: null,
        revision: 3,
        updatedAt: "2026-09-09T10:00:00.000Z",
      }).revision,
    ).toBe(3);
  });

  it("compares evidence by semantic provenance rather than retry ids and timestamps", () => {
    const first = decodeEvidence({
      id: "evidence_1",
      provenance: {
        contextId: "company_a",
        scope: { contextId: "company_a", project: { environmentId: "laptop", projectId: "p1" } },
        sourceKind: "evaluation",
        sourceId: "run-1",
        observedAt: "2026-09-09T10:00:00.000Z",
        cursor: "cursor-1",
        fingerprint: "sha256:same",
      },
      summary: "The focused test caught a regression.",
      createdAt: "2026-09-09T10:01:00.000Z",
      expiresAt: "2026-10-09T10:01:00.000Z",
    });
    const retry = decodeEvidence({
      ...first,
      id: "evidence_2",
      createdAt: "2026-09-09T10:02:00.000Z",
    });
    expect(axisLearningEvidenceSemanticallyEquals(first, retry)).toBe(true);
    expect(
      axisLearningEvidenceSemanticallyEquals(first, { ...retry, summary: "Different result." }),
    ).toBe(false);
  });
});

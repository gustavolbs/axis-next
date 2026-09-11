import { describe, expect, it } from "vite-plus/test";

import {
  AxisContextId,
  AxisContextProjectScope,
  AxisLearningActivationState,
  AxisLearningLifecycleEvent,
  AxisLearningProposal,
  AxisLearningSnapshot,
  AxisLearningVersion,
  CommandId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  buildDeactivateInput,
  buildProjectLearningModel,
  buildVersionActionInput,
  projectLearningVersionAction,
} from "./projectLearningModel";

const decodeSnapshot = Schema.decodeUnknownSync(AxisLearningSnapshot);
const decodeProposal = Schema.decodeUnknownSync(AxisLearningProposal);
const decodeVersion = Schema.decodeUnknownSync(AxisLearningVersion);
const decodeActiveState = Schema.decodeUnknownSync(AxisLearningActivationState);
const decodeLifecycle = Schema.decodeUnknownSync(AxisLearningLifecycleEvent);
const decodeScope = Schema.decodeUnknownSync(AxisContextProjectScope);

const contextId = AxisContextId.make("company");
const projectScope = decodeScope({
  contextId,
  project: { environmentId: "remote", projectId: "axis" },
});
const scope = { contextId: projectScope.contextId, project: projectScope.project };
const commandId = CommandId.make("cmd_1");

const proposal = (overrides: Record<string, unknown> = {}) =>
  decodeProposal({
    id: "learning_proposal_1",
    contextId,
    scope,
    kind: "workflow-recommendation",
    targetKey: "skill:review",
    title: "Tighten review checklist",
    rationale: "Recurring miss in review.",
    evidenceIds: ["learning_evidence_1"],
    change: { op: "set-rule", rule: null },
    status: "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
    ...overrides,
  });

const version = (overrides: Record<string, unknown> = {}) =>
  decodeVersion({
    id: "learning_version_1",
    proposalId: "learning_proposal_1",
    contextId,
    scope,
    kind: "workflow-recommendation",
    targetKey: "skill:review",
    title: "Tighten review checklist",
    rationale: "Recurring miss in review.",
    evidenceIds: ["learning_evidence_1"],
    change: { op: "set-rule", rule: null },
    approvedBy: "reviewer@example.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

describe("projectLearningVersionAction", () => {
  it("stays inactive when no active state exists yet", () => {
    const v = version();
    expect(projectLearningVersionAction(v, null, [v])).toBe("activate");
  });

  it("reports active only when the observed active state points at this version", () => {
    const v = version();
    const active = decodeActiveState({
      scope,
      targetKey: v.targetKey,
      versionId: v.id,
      revision: 3,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(projectLearningVersionAction(v, active, [v])).toBe("active");
  });

  it("never reports active for a null versionId (explicit deactivation)", () => {
    const v = version();
    const active = decodeActiveState({
      scope,
      targetKey: v.targetKey,
      versionId: null,
      revision: 4,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(projectLearningVersionAction(v, active, [v])).toBe("activate");
  });

  it("reports rollback when the version predates the currently active one", () => {
    const older = version({ id: "learning_version_1", createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = version({ id: "learning_version_2", createdAt: "2026-01-03T00:00:00.000Z" });
    const active = decodeActiveState({
      scope,
      targetKey: newer.targetKey,
      versionId: newer.id,
      revision: 2,
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    expect(projectLearningVersionAction(older, active, [older, newer])).toBe("rollback");
  });
});

describe("buildProjectLearningModel", () => {
  it("groups proposals by status and scopes them to the project", () => {
    const other = { contextId, project: { environmentId: "remote", projectId: "other" } };
    const snapshot = decodeSnapshot({
      contextId,
      evidence: [],
      proposals: [
        proposal({ id: "learning_proposal_1", status: "draft" }),
        proposal({ id: "learning_proposal_2", status: "in-review", scope: other }),
      ],
      versions: [],
      activeVersions: [],
      activeStates: [],
      lifecycle: [],
    });
    const model = buildProjectLearningModel(projectScope, snapshot);
    expect(model.proposalsByStatus.draft).toHaveLength(1);
    expect(model.proposalsByStatus["in-review"]).toHaveLength(0);
  });

  it("approve never flips a version to active on its own", () => {
    const v = version();
    const snapshot = decodeSnapshot({
      contextId,
      evidence: [],
      proposals: [proposal({ status: "approved" })],
      versions: [v],
      activeVersions: [],
      activeStates: [],
      lifecycle: [],
    });
    const model = buildProjectLearningModel(projectScope, snapshot);
    expect(model.versionEntries[0]?.action).toBe("activate");
  });

  it("keeps the previous version and note in history without exposing targetKey as required input", () => {
    const v1 = version({ id: "learning_version_1", createdAt: "2026-01-01T00:00:00.000Z" });
    const v2 = version({ id: "learning_version_2", createdAt: "2026-01-03T00:00:00.000Z" });
    const event = decodeLifecycle({
      id: "learning_lifecycle_1",
      contextId,
      scope,
      action: "activated",
      proposalId: null,
      versionId: v2.id,
      previousVersionId: v1.id,
      actor: "reviewer@example.com",
      note: "Superseded stale checklist wording.",
      createdAt: "2026-01-03T00:01:00.000Z",
    });
    const snapshot = decodeSnapshot({
      contextId,
      evidence: [],
      proposals: [],
      versions: [v1, v2],
      activeVersions: [],
      activeStates: [],
      lifecycle: [event],
    });
    const model = buildProjectLearningModel(projectScope, snapshot);
    expect(model.history).toHaveLength(1);
    expect(model.history[0]?.previousVersionTitle).toBe(v1.title);
    expect(model.history[0]?.versionTitle).toBe(v2.title);
    expect(model.history[0]?.event.note).toBe("Superseded stale checklist wording.");
  });
});

describe("buildVersionActionInput", () => {
  it("sends the observed expectedRevision, not a hardcoded zero", () => {
    const v = version();
    const active = decodeActiveState({
      scope,
      targetKey: v.targetKey,
      versionId: "learning_version_0",
      revision: 7,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const result = buildVersionActionInput(
      { version: v, action: "rollback", activeState: active },
      commandId,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.expectedRevision).toBe(7);
      expect(result.input.commandId).toBe(commandId);
    }
  });

  it("refuses to re-activate an already active version", () => {
    const v = version();
    const result = buildVersionActionInput(
      { version: v, action: "active", activeState: null },
      commandId,
    );
    expect(result.ok).toBe(false);
  });
});

describe("buildDeactivateInput", () => {
  it("only builds an input for the currently active entry", () => {
    const v = version();
    const active = decodeActiveState({
      scope,
      targetKey: v.targetKey,
      versionId: v.id,
      revision: 5,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const ok = buildDeactivateInput(
      { version: v, action: "active", activeState: active },
      commandId,
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.input.expectedRevision).toBe(5);

    const notActive = buildDeactivateInput(
      { version: v, action: "activate", activeState: null },
      commandId,
    );
    expect(notActive.ok).toBe(false);
  });
});

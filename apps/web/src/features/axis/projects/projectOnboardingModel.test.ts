import { describe, expect, it } from "vite-plus/test";

import { AxisContextId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  buildProjectOnboardingModel,
  createProjectOnboardingState,
  reduceProjectOnboardingState,
  setProjectOnboardingDecision,
  type ProjectOnboardingCandidateRule,
  type ProjectOnboardingRun,
} from "./projectOnboardingModel";

const scope = {
  contextId: AxisContextId.make("personal"),
  project: {
    environmentId: EnvironmentId.make("local"),
    projectId: ProjectId.make("axis"),
  },
};

const candidate = (id: string, text: string): ProjectOnboardingCandidateRule => ({
  id,
  category: "instruction" as const,
  text,
});

const run = (status: ProjectOnboardingRun["status"] = "completed"): ProjectOnboardingRun => ({
  id: "run-axis",
  scope,
  execution: {
    threadId: "thread-axis",
    turnId: "turn-axis",
    commandId: "command-axis",
  },
  status,
  sources: [],
  candidateRules: [candidate("candidate-test", "Run the focused test command.")],
  conflicts: [
    {
      id: "conflict-tests",
      candidateRuleIds: ["candidate-test", "candidate-coverage"],
      description: "The project has two test policies.",
    },
  ],
  decisions: [],
  error: status === "failed" ? "The analysis failed." : null,
});

describe("project onboarding model", () => {
  it("restores the applied phase from the durable server receipt and allows another analysis", () => {
    const input = {
      scope,
      run: { ...run(), applied: true },
      connectionState: "connected" as const,
      profileRevision: 1,
    };
    const model = buildProjectOnboardingModel(input);
    expect(model.phase).toBe("applied");
    expect(model.canAnalyze).toBe(true);
    expect(model.canApply).toBe(false);
    expect(buildProjectOnboardingModel({ ...input, run: run() }).phase).toBe("review");
    expect(
      buildProjectOnboardingModel({ ...input, run: { ...run("failed"), applied: true } }).phase,
    ).toBe("failed");
  });
  it("keeps cancel available for a connected analysis and blocks mutations offline or across scopes", () => {
    const input = {
      scope,
      run: run("running"),
      connectionState: "connected" as const,
      profileRevision: 0,
    };
    expect(buildProjectOnboardingModel(input).canCancel).toBe(true);
    expect(
      buildProjectOnboardingModel({ ...input, connectionState: "disconnected" }).canCancel,
    ).toBe(false);
    expect(
      buildProjectOnboardingModel({
        ...input,
        scope: { ...scope, contextId: AxisContextId.make("other") },
      }).canCancel,
    ).toBe(false);
    expect(buildProjectOnboardingModel({ ...input, run: run("failed") }).canRetry).toBe(true);
    expect(buildProjectOnboardingModel({ ...input, run: run("failed") }).canAnalyze).toBe(false);
    expect(
      buildProjectOnboardingModel({ ...input, run: null, error: "Could not load" }).canRetry,
    ).toBe(false);
  });
  it("keeps detected candidates separate from manual decisions and exposes real progress", () => {
    const decision = setProjectOnboardingDecision(
      [],
      "candidate-test",
      "accept",
      "This is the project's explicit command.",
    );
    const model = buildProjectOnboardingModel({
      scope,
      run: run(),
      connectionState: "connected",
      profileRevision: 3,
      progress: { stage: "analyzing", completed: 2, total: 4, label: "Analyzing project" },
      decisions: [decision],
    });

    expect(model.candidates.map((item) => item.text)).toEqual(["Run the focused test command."]);
    expect(model.manualDecisions).toEqual([decision]);
    expect(model.pendingDecisions).toHaveLength(0);
    expect(model.progressPercent).toBe(50);
    expect(model.canApply).toBe(true);
  });

  it("maps snapshot lifecycle states without treating a run as a successful apply", () => {
    expect(
      buildProjectOnboardingModel({
        scope,
        run: run("running"),
        connectionState: "connected",
        profileRevision: 0,
      }).phase,
    ).toBe("analyzing");
    expect(
      buildProjectOnboardingModel({
        scope,
        run: run("cancelled"),
        connectionState: "connected",
        profileRevision: 0,
      }).phase,
    ).toBe("cancelled");
    expect(
      buildProjectOnboardingModel({
        scope,
        run: run("failed"),
        connectionState: "connected",
        profileRevision: 0,
      }).phase,
    ).toBe("failed");
    expect(
      buildProjectOnboardingModel({
        scope,
        run: run(),
        connectionState: "disconnected",
        profileRevision: 0,
      }).applySucceeded,
    ).toBe(false);
  });

  it("guards apply until every candidate has a decision", () => {
    const model = buildProjectOnboardingModel({
      scope,
      run: run(),
      connectionState: "connected",
      profileRevision: 1,
    });
    expect(model.pendingDecisions).toHaveLength(1);
    expect(model.canApply).toBe(false);
  });

  it("does not apply a partial run when a permitted source failed", () => {
    const incomplete = {
      ...run(),
      sources: [{ path: "AGENTS.md", status: "failed" as const, error: "Permission denied." }],
    };
    const model = buildProjectOnboardingModel({
      scope,
      run: incomplete,
      connectionState: "connected",
      profileRevision: 1,
      decisions: [setProjectOnboardingDecision([], "candidate-test", "accept")],
    });
    expect(model.canApply).toBe(false);
  });

  it("reduces analyze, progress, decision, apply, and completion as separate transitions", () => {
    let state = createProjectOnboardingState(scope, run());
    state = reduceProjectOnboardingState(state, {
      type: "decision-changed",
      decision: setProjectOnboardingDecision([], "candidate-test", "defer"),
    });
    expect(state.phase).toBe("review");
    state = reduceProjectOnboardingState(state, { type: "analyze" });
    expect(state.phase).toBe("analyzing");
    state = reduceProjectOnboardingState(state, {
      type: "progress",
      progress: { stage: "analyzing", completed: 1, total: 2, label: "Reading sources" },
    });
    expect(state.progress?.completed).toBe(1);
    state = reduceProjectOnboardingState(state, { type: "run-updated", run: run() });
    state = reduceProjectOnboardingState(state, {
      type: "decision-changed",
      decision: setProjectOnboardingDecision(state.decisions, "candidate-test", "accept"),
    });
    state = reduceProjectOnboardingState(state, { type: "apply" });
    expect(state.phase).toBe("applying");
    state = reduceProjectOnboardingState(state, { type: "apply-succeeded" });
    expect(state.phase).toBe("applied");
  });

  it("keeps cancellation and retry explicit and never makes cancellation successful", () => {
    let state = createProjectOnboardingState(scope, run("running"));
    state = reduceProjectOnboardingState(state, { type: "cancel" });
    expect(state.phase).toBe("cancelling");
    state = reduceProjectOnboardingState(state, { type: "cancelled" });
    expect(state.phase).toBe("cancelled");
    expect(state.phase).not.toBe("applied");
    state = reduceProjectOnboardingState(state, { type: "retry" });
    expect(state.phase).toBe("analyzing");
  });

  it("restores the snapshot after reconnect and preserves failure visibility", () => {
    let state = createProjectOnboardingState(scope, run());
    state = reduceProjectOnboardingState(state, { type: "reconnect" });
    expect(state.phase).toBe("reconnecting");
    state = reduceProjectOnboardingState(state, { type: "reconnected", run: run() });
    expect(state.phase).toBe("review");
    state = reduceProjectOnboardingState(state, { type: "failed", message: "Connection lost." });
    expect(state.phase).toBe("failed");
    expect(state.error).toBe("Connection lost.");
    expect(state.phase).not.toBe("applied");
  });

  it("turns an apply failure into a failed state instead of a false success", () => {
    let state = createProjectOnboardingState(scope, run());
    state = reduceProjectOnboardingState(state, {
      type: "decision-changed",
      decision: setProjectOnboardingDecision([], "candidate-test", "accept"),
    });
    state = reduceProjectOnboardingState(state, { type: "apply" });
    state = reduceProjectOnboardingState(state, { type: "failed", message: "Apply rejected." });
    expect(state.phase).toBe("failed");
    expect(state.error).toBe("Apply rejected.");
    expect(state.phase).not.toBe("applied");
  });

  it("blocks apply on a revision conflict and allows retry without claiming success", () => {
    let state = createProjectOnboardingState(scope, run());
    const decision = setProjectOnboardingDecision([], "candidate-test", "accept");
    state = reduceProjectOnboardingState(state, { type: "decision-changed", decision });
    state = reduceProjectOnboardingState(state, { type: "apply" });
    state = reduceProjectOnboardingState(state, {
      type: "revision-conflict",
      expected: 2,
      actual: 3,
    });
    expect(state.phase).toBe("revision-conflict");
    expect(state.revisionConflict).toEqual({ expected: 2, actual: 3 });
    expect(state.phase).not.toBe("applied");
    state = reduceProjectOnboardingState(state, { type: "retry" });
    expect(state.phase).toBe("analyzing");
  });

  it("does not accept a snapshot from another project scope", () => {
    const other = {
      ...run(),
      scope: { ...scope, project: { ...scope.project, projectId: ProjectId.make("other") } },
    };
    const model = buildProjectOnboardingModel({
      scope,
      run: other,
      connectionState: "connected",
      profileRevision: 0,
    });
    expect(model.scopeMatches).toBe(false);
    expect(model.phase).toBe("failed");
    expect(model.canApply).toBe(false);
  });

  it("uses a stable decision identity when a candidate is decided locally", () => {
    const decision = setProjectOnboardingDecision([], "candidate-test", "reject");
    expect(decision.id).toBe("decision-candidate-test");
  });
});

import type { AxisContextProjectScope, EnvironmentConnectionState } from "@t3tools/contracts";

/** UI projection consumed by the O06 transport once its RPC is wired. */
export type ProjectOnboardingRunStatus = "running" | "cancelled" | "failed" | "completed";

export interface ProjectOnboardingSource {
  readonly path: string;
  readonly status: "read" | "absent" | "failed";
  readonly error: string | null;
  readonly warning?: string;
}

export interface ProjectOnboardingCandidateRule {
  readonly id: string;
  readonly category:
    | "tool"
    | "command"
    | "convention"
    | "test-policy"
    | "pull-request-policy"
    | "path"
    | "instruction";
  readonly text: string;
}

export interface ProjectOnboardingConflict {
  readonly id: string;
  readonly candidateRuleIds: ReadonlyArray<string>;
  readonly description: string;
}

export interface ProjectOnboardingDecision {
  readonly id: string;
  readonly candidateRuleId: string;
  readonly decision: "accept" | "reject" | "defer";
  readonly note: string | null;
}

export interface ProjectOnboardingRun {
  readonly id: string;
  readonly scope: AxisContextProjectScope;
  readonly execution: {
    readonly threadId: string;
    readonly turnId: string | null;
    readonly commandId: string;
  };
  readonly status: ProjectOnboardingRunStatus;
  readonly sources: ReadonlyArray<ProjectOnboardingSource>;
  readonly candidateRules: ReadonlyArray<ProjectOnboardingCandidateRule>;
  readonly conflicts: ReadonlyArray<ProjectOnboardingConflict>;
  readonly decisions: ReadonlyArray<ProjectOnboardingDecision>;
  readonly error: string | null;
}

export type ProjectOnboardingConnectionState = EnvironmentConnectionState | "unauthorized";

export type ProjectOnboardingOperation =
  | "analyze"
  | "apply"
  | "applied"
  | "cancel"
  | "reconnect"
  | "retry"
  | null;

export type ProjectOnboardingPhase =
  | "idle"
  | "analyzing"
  | "review"
  | "applying"
  | "cancelling"
  | "cancelled"
  | "failed"
  | "reconnecting"
  | "revision-conflict"
  | "applied";

export type ProjectOnboardingProgressStage = "collecting" | "analyzing" | "applying";

export interface ProjectOnboardingProgress {
  readonly stage: ProjectOnboardingProgressStage;
  readonly completed: number;
  readonly total: number;
  readonly label: string;
}

export interface ProjectOnboardingRevisionConflict {
  readonly expected: number;
  readonly actual: number;
}

export interface ProjectOnboardingQuery {
  readonly data: ProjectOnboardingRun | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export interface ProjectOnboardingModelInput {
  readonly scope: AxisContextProjectScope;
  readonly run: ProjectOnboardingRun | null;
  /** Overview can only start analysis when a real T3 execution is available. */
  readonly analysisAvailable?: boolean;
  readonly connectionState: ProjectOnboardingConnectionState;
  readonly profileRevision: number | null;
  readonly progress?: ProjectOnboardingProgress | null;
  readonly operation?: ProjectOnboardingOperation;
  readonly error?: string | null;
  readonly revisionConflict?: ProjectOnboardingRevisionConflict | null;
  /** Local edits take precedence over decisions in the server snapshot. */
  readonly decisions?: ReadonlyArray<ProjectOnboardingDecision>;
}

export interface ProjectOnboardingModel {
  readonly scopeMatches: boolean;
  readonly phase: ProjectOnboardingPhase;
  readonly run: ProjectOnboardingRun | null;
  readonly progress: ProjectOnboardingProgress | null;
  readonly progressPercent: number | null;
  readonly sources: ReadonlyArray<ProjectOnboardingSource>;
  readonly candidates: ReadonlyArray<ProjectOnboardingCandidateRule>;
  readonly manualDecisions: ReadonlyArray<ProjectOnboardingDecision>;
  readonly pendingDecisions: ReadonlyArray<ProjectOnboardingCandidateRule>;
  readonly conflicts: ReadonlyArray<ProjectOnboardingConflict>;
  readonly connectionState: ProjectOnboardingConnectionState;
  readonly connectionLabel: string;
  readonly error: string | null;
  readonly revisionConflict: ProjectOnboardingRevisionConflict | null;
  readonly applySucceeded: boolean;
  readonly canAnalyze: boolean;
  readonly canApply: boolean;
  readonly canCancel: boolean;
  readonly canRetry: boolean;
  readonly canReconnect: boolean;
}

export interface ProjectOnboardingState {
  readonly scope: AxisContextProjectScope;
  readonly phase: ProjectOnboardingPhase;
  readonly run: ProjectOnboardingRun | null;
  readonly progress: ProjectOnboardingProgress | null;
  readonly decisions: ReadonlyArray<ProjectOnboardingDecision>;
  readonly error: string | null;
  readonly revisionConflict: ProjectOnboardingRevisionConflict | null;
  readonly resumePhase: ProjectOnboardingPhase | null;
}

export type ProjectOnboardingEvent =
  | { readonly type: "analyze" }
  | { readonly type: "progress"; readonly progress: ProjectOnboardingProgress }
  | { readonly type: "run-updated"; readonly run: ProjectOnboardingRun }
  | { readonly type: "decision-changed"; readonly decision: ProjectOnboardingDecision }
  | { readonly type: "apply" }
  | { readonly type: "apply-succeeded" }
  | { readonly type: "cancel" }
  | { readonly type: "cancelled"; readonly run?: ProjectOnboardingRun | null }
  | { readonly type: "retry" }
  | { readonly type: "reconnect" }
  | { readonly type: "reconnected"; readonly run: ProjectOnboardingRun | null }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "revision-conflict"; readonly expected: number; readonly actual: number };

const sameScope = (left: AxisContextProjectScope, right: AxisContextProjectScope): boolean =>
  left.contextId === right.contextId &&
  left.project.environmentId === right.project.environmentId &&
  left.project.projectId === right.project.projectId;

const phaseFromRunStatus = (status: ProjectOnboardingRunStatus): ProjectOnboardingPhase => {
  switch (status) {
    case "running":
      return "analyzing";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "review";
  }
};

const replaceDecision = (
  decisions: ReadonlyArray<ProjectOnboardingDecision>,
  decision: ProjectOnboardingDecision,
): ReadonlyArray<ProjectOnboardingDecision> => {
  const index = decisions.findIndex(
    (current) => current.candidateRuleId === decision.candidateRuleId,
  );
  return index === -1
    ? [...decisions, decision]
    : decisions.map((current, currentIndex) => (currentIndex === index ? decision : current));
};

export function setProjectOnboardingDecision(
  decisions: ReadonlyArray<ProjectOnboardingDecision>,
  candidateRuleId: ProjectOnboardingCandidateRule["id"],
  value: ProjectOnboardingDecision["decision"],
  note: string | null = null,
): ProjectOnboardingDecision {
  const existing = decisions.find((decision) => decision.candidateRuleId === candidateRuleId);
  return {
    id: existing?.id ?? `decision-${candidateRuleId}`,
    candidateRuleId,
    decision: value,
    note,
  };
}

export function pendingProjectOnboardingDecisions(
  candidates: ReadonlyArray<ProjectOnboardingCandidateRule>,
  decisions: ReadonlyArray<ProjectOnboardingDecision>,
): ReadonlyArray<ProjectOnboardingCandidateRule> {
  const decided = new Set(decisions.map((decision) => decision.candidateRuleId));
  return candidates.filter((candidate) => !decided.has(candidate.id));
}

export function projectOnboardingPhaseFromSnapshot(
  run: ProjectOnboardingRun | null,
): ProjectOnboardingPhase {
  return run === null ? "idle" : phaseFromRunStatus(run.status);
}

export function buildProjectOnboardingModel(
  input: ProjectOnboardingModelInput,
): ProjectOnboardingModel {
  const run = input.run;
  const scopeMatches = run === null || sameScope(input.scope, run.scope);
  const snapshotDecisions = input.decisions ?? run?.decisions ?? [];
  const progress = input.progress ?? null;
  const snapshotPhase = scopeMatches ? projectOnboardingPhaseFromSnapshot(run) : "failed";
  const phase: ProjectOnboardingPhase = !scopeMatches
    ? "failed"
    : input.revisionConflict !== undefined && input.revisionConflict !== null
      ? "revision-conflict"
      : input.error
        ? "failed"
        : input.operation === "reconnect"
          ? "reconnecting"
          : input.operation === "applied"
            ? "applied"
            : input.operation === "analyze" || input.operation === "retry"
              ? "analyzing"
              : input.operation === "apply"
                ? "applying"
                : input.operation === "cancel"
                  ? "cancelling"
                  : snapshotPhase;
  const candidates = run?.candidateRules ?? [];
  const pendingDecisions = pendingProjectOnboardingDecisions(candidates, snapshotDecisions);
  const sourcesReadable = (run?.sources ?? []).every((source) => source.status !== "failed");
  const connected = input.connectionState === "connected";
  const applySucceeded = phase === "applied";
  const canApply =
    connected &&
    scopeMatches &&
    phase === "review" &&
    run !== null &&
    sourcesReadable &&
    pendingDecisions.length === 0 &&
    input.profileRevision !== null;
  const error = !scopeMatches
    ? "The onboarding snapshot belongs to another project. Refresh before continuing."
    : (input.error ?? run?.error ?? null);

  return {
    scopeMatches,
    phase,
    run,
    progress,
    progressPercent:
      progress !== null && progress.total > 0
        ? Math.min(100, Math.max(0, Math.round((progress.completed / progress.total) * 100)))
        : null,
    sources: run?.sources ?? [],
    candidates,
    manualDecisions: snapshotDecisions,
    pendingDecisions,
    conflicts: run?.conflicts ?? [],
    connectionState: input.connectionState,
    connectionLabel:
      input.connectionState === "connected"
        ? "Connected"
        : input.connectionState === "connecting"
          ? "Connecting"
          : input.connectionState === "disconnected"
            ? "Offline"
            : input.connectionState === "error"
              ? "Connection error"
              : "Not authorized",
    error,
    revisionConflict: input.revisionConflict ?? null,
    applySucceeded,
    canAnalyze:
      (input.analysisAvailable ?? true) &&
      connected &&
      scopeMatches &&
      (phase === "idle" || phase === "applied"),
    canApply,
    canCancel: connected && scopeMatches && phase === "analyzing",
    canRetry:
      connected &&
      scopeMatches &&
      run !== null &&
      (phase === "failed" || phase === "cancelled" || phase === "revision-conflict"),
    canReconnect: input.connectionState === "disconnected" || input.connectionState === "error",
  };
}

const stateFromRun = (
  state: ProjectOnboardingState,
  run: ProjectOnboardingRun | null,
): ProjectOnboardingState => ({
  ...state,
  phase: run === null ? "idle" : phaseFromRunStatus(run.status),
  run,
  decisions: run?.decisions ?? [],
  progress: run?.status === "running" ? state.progress : null,
  error: run?.error ?? null,
  revisionConflict: null,
  resumePhase: null,
});

export function createProjectOnboardingState(
  scope: AxisContextProjectScope,
  run: ProjectOnboardingRun | null = null,
): ProjectOnboardingState {
  return {
    scope,
    phase: run === null ? "idle" : phaseFromRunStatus(run.status),
    run,
    progress: null,
    decisions: run?.decisions ?? [],
    error: run?.error ?? null,
    revisionConflict: null,
    resumePhase: null,
  };
}

export function reduceProjectOnboardingState(
  state: ProjectOnboardingState,
  event: ProjectOnboardingEvent,
): ProjectOnboardingState {
  switch (event.type) {
    case "analyze":
      return state.phase === "idle" ||
        state.phase === "review" ||
        state.phase === "cancelled" ||
        state.phase === "failed"
        ? { ...state, phase: "analyzing", progress: null, error: null, revisionConflict: null }
        : state;
    case "progress":
      return state.phase === "analyzing" || state.phase === "applying"
        ? { ...state, progress: event.progress }
        : state;
    case "run-updated":
      return stateFromRun(state, event.run);
    case "decision-changed":
      return state.phase === "review" || state.phase === "revision-conflict"
        ? { ...state, decisions: replaceDecision(state.decisions, event.decision), error: null }
        : state;
    case "apply":
      return state.phase === "review" &&
        pendingProjectOnboardingDecisions(state.run?.candidateRules ?? [], state.decisions)
          .length === 0
        ? { ...state, phase: "applying", progress: null, error: null, revisionConflict: null }
        : state;
    case "apply-succeeded":
      return state.phase === "applying"
        ? { ...state, phase: "applied", progress: null, error: null, revisionConflict: null }
        : state;
    case "cancel":
      return state.phase === "analyzing" ? { ...state, phase: "cancelling" } : state;
    case "cancelled":
      return {
        ...state,
        phase: "cancelled",
        run: event.run === undefined ? state.run : event.run,
        progress: null,
        error: event.run?.error ?? null,
        revisionConflict: null,
      };
    case "retry":
      return state.phase === "failed" ||
        state.phase === "cancelled" ||
        state.phase === "revision-conflict"
        ? { ...state, phase: "analyzing", progress: null, error: null, revisionConflict: null }
        : state;
    case "reconnect":
      return state.phase === "reconnecting"
        ? state
        : { ...state, phase: "reconnecting", resumePhase: state.phase };
    case "reconnected":
      return stateFromRun(
        {
          ...state,
          phase: state.resumePhase ?? (event.run === null ? "idle" : "review"),
          error: null,
        },
        event.run,
      );
    case "failed":
      return {
        ...state,
        phase: "failed",
        progress: null,
        error: event.message,
        revisionConflict: null,
      };
    case "revision-conflict":
      return {
        ...state,
        phase: "revision-conflict",
        progress: null,
        error: "The project profile changed before these decisions were applied.",
        revisionConflict: { expected: event.expected, actual: event.actual },
      };
  }
}

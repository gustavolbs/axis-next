import { useMemo, useState } from "react";
import {
  CheckIcon,
  FileTextIcon,
  HistoryIcon,
  ListChecksIcon,
  PlusIcon,
  RotateCcwIcon,
  SendIcon,
  XIcon,
} from "lucide-react";

import {
  AxisContextId,
  CommandId,
  AxisLearningEvidenceId,
  type AxisLearningEngineStatus,
  type AxisContext,
  type AxisContextProjectBinding,
  type AxisLearningProposal,
  type AxisLearningProposalKind,
  type AxisLearningVersion,
  type EnvironmentId,
  type AxisContextProjectScope,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { randomUUID } from "~/lib/utils";
import { ensureLocalApi } from "~/localApi";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import {
  buildManualLearningEvidence,
  buildManualLearningProposal,
  describeLearningScopeGroup,
  learningVersionAction,
  learningAnalysisEvidenceIds,
} from "./AxisLearningSettings.logic";
import { AxisHermesSettings } from "./AxisHermesSettings";

const PROPOSAL_KINDS: ReadonlyArray<{
  readonly value: AxisLearningProposalKind;
  readonly label: string;
}> = [
  { value: "provider-skill", label: "Provider skill" },
  { value: "provider-instructions", label: "Provider instructions" },
  { value: "work-hub-policy", label: "Work Hub policy" },
  { value: "scheduled-activity", label: "Scheduled activity" },
  { value: "workflow-recommendation", label: "Workflow recommendation" },
];

type LearningView = "review" | "evidence" | "versions" | "history";
export type AxisLearningConnectionState = "connected" | "connecting" | "disconnected" | "error";

function entityId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function errorDescription<E>(
  result: Extract<AtomCommandResult<unknown, E>, { readonly _tag: "Failure" }>,
): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message ? error.message : "Refresh and try again.";
}

interface AxisLearningSettingsProps {
  readonly environmentId: EnvironmentId;
  readonly contexts: ReadonlyArray<AxisContext>;
  readonly projectBindings: ReadonlyArray<AxisContextProjectBinding>;
  readonly fixedScope?: AxisContextProjectScope;
  readonly projectLabel?: string;
  readonly connectionState?: AxisLearningConnectionState;
}

export function AxisLearningSettings(props: AxisLearningSettingsProps) {
  const { environmentId, contexts, projectBindings, fixedScope } = props;
  const [selectedContextId, setSelectedContextId] = useState<AxisContextId | null>(
    contexts[0]?.id ?? null,
  );
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const contextId =
    fixedScope?.contextId ??
    (selectedContextId !== null && contexts.some((context) => context.id === selectedContextId)
      ? selectedContextId
      : (contexts[0]?.id ?? null));
  const contextProjects = projectBindings.filter((binding) => binding.contextId === contextId);
  const selectedProject =
    selectedProjectKey === null
      ? undefined
      : contextProjects.find(
          (binding) =>
            `${binding.project.environmentId}:${binding.project.projectId}` === selectedProjectKey,
        )?.project;
  const learningScope =
    fixedScope ??
    (contextId === null || selectedProject === undefined
      ? undefined
      : { contextId, project: selectedProject });
  return (
    <AxisLearningScopeSettings
      {...props}
      key={JSON.stringify([
        environmentId,
        contextId,
        learningScope?.project.environmentId,
        learningScope?.project.projectId,
      ])}
      contextId={contextId}
      contextProjects={contextProjects}
      learningScope={learningScope}
      selectedProjectKey={selectedProjectKey}
      selectContext={(id) => {
        setSelectedContextId(id);
        setSelectedProjectKey(null);
      }}
      selectProject={setSelectedProjectKey}
    />
  );
}

/** Remount all drafts and in-flight UI state when the effective scope changes. */
function AxisLearningScopeSettings({
  environmentId,
  contexts,
  fixedScope,
  projectLabel,
  connectionState = "connected",
  contextId,
  contextProjects,
  learningScope,
  selectedProjectKey,
  selectContext,
  selectProject,
}: AxisLearningSettingsProps & {
  readonly contextId: AxisContextId | null;
  readonly contextProjects: ReadonlyArray<AxisContextProjectBinding>;
  readonly learningScope: AxisContextProjectScope | undefined;
  readonly selectedProjectKey: string | null;
  readonly selectContext: (id: AxisContextId) => void;
  readonly selectProject: (key: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [learningView, setLearningView] = useState<LearningView>("review");
  const [evidenceSummary, setEvidenceSummary] = useState("");
  const [proposalKind, setProposalKind] =
    useState<AxisLearningProposalKind>("workflow-recommendation");
  const [proposalTarget, setProposalTarget] = useState("");
  const [proposalTitle, setProposalTitle] = useState("");
  const [proposalRationale, setProposalRationale] = useState("");
  const [proposalChange, setProposalChange] = useState("");
  const [proposalEvidenceId, setProposalEvidenceId] = useState("");
  const [engineStatus, setEngineStatus] = useState<AxisLearningEngineStatus | null>(null);
  const writesAvailable = connectionState === undefined || connectionState === "connected";

  const query = useEnvironmentQuery(
    contextId === null || !writesAvailable
      ? null
      : serverEnvironment.axisLearningSnapshot({
          environmentId,
          input: { contextId, ...(learningScope === undefined ? {} : { scope: learningScope }) },
        }),
  );
  const recordEvidence = useAtomCommand(serverEnvironment.recordAxisLearningEvidence, {
    reportFailure: false,
  });
  const createProposal = useAtomCommand(serverEnvironment.createAxisLearningProposal, {
    reportFailure: false,
  });
  const submitProposal = useAtomCommand(serverEnvironment.submitAxisLearningProposal, {
    reportFailure: false,
  });
  const approveProposal = useAtomCommand(serverEnvironment.approveAxisLearningProposal, {
    reportFailure: false,
  });
  const rejectProposal = useAtomCommand(serverEnvironment.rejectAxisLearningProposal, {
    reportFailure: false,
  });
  const activateVersion = useAtomCommand(serverEnvironment.activateAxisLearningVersion, {
    reportFailure: false,
  });
  const rollbackVersion = useAtomCommand(serverEnvironment.rollbackAxisLearningVersion, {
    reportFailure: false,
  });
  const deactivateVersion = useAtomCommand(serverEnvironment.deactivateAxisLearningVersion, {
    reportFailure: false,
  });
  const requestImprovements = useAtomCommand(serverEnvironment.requestAxisLearningImprovements, {
    reportFailure: false,
  });

  const snapshot = query.data;
  const scopeGroup = describeLearningScopeGroup(learningScope?.project ?? null, projectLabel);
  const analysisEvidenceIds = useMemo(
    () => learningAnalysisEvidenceIds(snapshot?.evidence ?? []),
    [snapshot],
  );
  const evidenceById = useMemo(
    () => new Map(snapshot?.evidence.map((evidence) => [evidence.id, evidence]) ?? []),
    [snapshot],
  );

  async function finish<A, E>(result: AtomCommandResult<A, E>, successTitle: string) {
    setBusy(false);
    if (result._tag === "Success") {
      query.refresh();
      toastManager.add({ type: "success", title: successTitle });
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not update Axis Learning",
        description: errorDescription(result),
      });
    }
    return false;
  }

  async function addEvidence() {
    if (contextId === null || !writesAvailable || busy || !evidenceSummary.trim()) return;
    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + 30);
    setBusy(true);
    const saved = await finish(
      await recordEvidence({
        environmentId,
        input: {
          evidence: buildManualLearningEvidence({
            contextId,
            ...(learningScope === undefined ? {} : { scope: learningScope }),
            id: entityId("learning_evidence"),
            sourceId: "axis-learning-settings",
            summary: evidenceSummary,
            observedAt: now.toISOString(),
            expiresAt: expiresAt.toISOString(),
          }),
        },
      }),
      "Evidence recorded",
    );
    if (saved) setEvidenceSummary("");
  }

  async function addProposal() {
    if (
      contextId === null ||
      !writesAvailable ||
      busy ||
      !proposalEvidenceId ||
      !proposalTarget.trim() ||
      !proposalTitle.trim() ||
      !proposalRationale.trim() ||
      !proposalChange.trim()
    ) {
      return;
    }
    setBusy(true);
    const saved = await finish(
      await createProposal({
        environmentId,
        input: {
          proposal: buildManualLearningProposal({
            contextId,
            ...(learningScope === undefined ? {} : { scope: learningScope }),
            id: entityId("learning_proposal"),
            kind: proposalKind,
            targetKey: proposalTarget,
            title: proposalTitle,
            rationale: proposalRationale,
            evidenceId: AxisLearningEvidenceId.make(proposalEvidenceId),
            change: proposalChange,
          }),
        },
      }),
      "Learning proposal created",
    );
    if (saved) {
      setProposalTarget("");
      setProposalTitle("");
      setProposalRationale("");
      setProposalChange("");
    }
  }

  async function submit(proposal: AxisLearningProposal) {
    if (busy || !writesAvailable) return;
    setBusy(true);
    await finish(
      await submitProposal({
        environmentId,
        input: { id: proposal.id, scope: proposal.scope ?? { contextId: proposal.contextId } },
      }),
      "Proposal submitted for review",
    );
  }

  async function approve(proposal: AxisLearningProposal, note: string) {
    if (busy || !writesAvailable) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Approve “${proposal.title}”? Approval creates an immutable version, but does not activate it.`,
    );
    if (!confirmed) return;
    setBusy(true);
    await finish(
      await approveProposal({
        environmentId,
        input: {
          id: proposal.id,
          scope: proposal.scope ?? { contextId: proposal.contextId },
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      }),
      "Proposal approved; activation is still required",
    );
  }

  async function reject(proposal: AxisLearningProposal, note: string) {
    if (busy) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Reject “${proposal.title}”? The proposal and review record will be retained.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setBusy(true);
    await finish(
      await rejectProposal({
        environmentId,
        input: {
          id: proposal.id,
          scope: proposal.scope ?? { contextId: proposal.contextId },
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      }),
      "Proposal rejected",
    );
  }

  async function applyVersion(version: AxisLearningVersion) {
    if (!snapshot || busy || !writesAvailable) return;
    const action = learningVersionAction(version, snapshot.activeVersions, snapshot.versions);
    if (action === "active") return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      action === "activate"
        ? `Activate “${version.title}” for ${version.targetKey}? This is an explicit change to the active learning version.`
        : `Roll back ${version.targetKey} to “${version.title}”? The current version remains in the immutable history.`,
      action === "rollback" ? { variant: "destructive" } : undefined,
    );
    if (!confirmed) return;
    const scope = version.scope ?? { contextId: version.contextId };
    const activeState = snapshot.activeStates.find(
      (item) =>
        item.targetKey === version.targetKey &&
        item.scope.contextId === scope.contextId &&
        item.scope.project?.environmentId === scope.project?.environmentId &&
        item.scope.project?.projectId === scope.project?.projectId,
    );
    const actionInput = {
      id: version.id,
      scope,
      targetKey: version.targetKey,
      versionId: version.id,
      expectedRevision: activeState?.revision ?? 0,
      commandId: CommandId.make(`axis-learning-${randomUUID().replaceAll("-", "")}`),
    };
    setBusy(true);
    await finish(
      action === "activate"
        ? await activateVersion({ environmentId, input: actionInput })
        : await rollbackVersion({ environmentId, input: actionInput }),
      action === "activate" ? "Version activated" : "Version rolled back",
    );
  }

  async function deactivate(version: AxisLearningVersion) {
    if (!snapshot || busy || !writesAvailable) return;
    const scope = version.scope ?? { contextId: version.contextId };
    const activeState = snapshot.activeStates.find(
      (item) =>
        item.targetKey === version.targetKey &&
        item.scope.contextId === scope.contextId &&
        item.scope.project?.environmentId === scope.project?.environmentId &&
        item.scope.project?.projectId === scope.project?.projectId &&
        item.versionId === version.id,
    );
    if (!activeState) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Deactivate “${version.title}” for ${version.targetKey}? The approved version will remain in history.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setBusy(true);
    await finish(
      await deactivateVersion({
        environmentId,
        input: {
          scope,
          targetKey: version.targetKey,
          expectedRevision: activeState.revision,
          commandId: CommandId.make(`axis-learning-${randomUUID().replaceAll("-", "")}`),
        },
      }),
      "Version deactivated",
    );
  }

  async function requestLearningImprovements() {
    if (!learningScope || !writesAvailable || busy || !snapshot || snapshot.evidence.length === 0)
      return;
    setBusy(true);
    const result = await requestImprovements({
      environmentId,
      input: {
        scope: learningScope,
        evidenceIds: analysisEvidenceIds,
        commandId: CommandId.make(`axis-learning-${randomUUID().replaceAll("-", "")}`),
        deadlineMs: 45_000,
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setEngineStatus(result.value.engine);
      query.refresh();
      toastManager.add({
        ...(result.value.status === "unavailable" ? {} : { type: "success" }),
        title:
          result.value.status === "unavailable"
            ? "Learning engine unavailable"
            : result.value.status === "proposals"
              ? "Learning proposals generated"
              : "Learning review complete",
        ...(result.value.reason ? { description: result.value.reason } : {}),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not run Axis Learning",
        description: errorDescription(result),
      });
    }
  }

  return (
    <div className="space-y-7">
      <AxisHermesSettings
        environmentId={environmentId}
        engineStatus={engineStatus}
        disabled={!writesAvailable}
      />
      <SettingsSection
        id="axis-learning"
        title="Axis Learning"
        description={
          fixedScope
            ? `Hermes analyzes new project evidence automatically for ${projectLabel ?? fixedScope.project.projectId}. You review every proposal before it can be used.`
            : `${scopeGroup.description} Hermes analyzes new project evidence automatically. You review every proposal before it can be used.`
        }
        variant="plain"
        className="space-y-5"
        headerAction={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {fixedScope ? (
              <Badge variant="secondary">
                {fixedScope.project.projectId} · {fixedScope.project.environmentId}
              </Badge>
            ) : null}
            {!fixedScope ? (
              <>
                <Select
                  value={contextId ?? undefined}
                  onValueChange={(value) => {
                    if (!value) return;
                    selectContext(AxisContextId.make(value));
                  }}
                >
                  <SelectTrigger size="xs" className="w-40" aria-label="Learning context">
                    <SelectValue placeholder="Context" />
                  </SelectTrigger>
                  <SelectPopup>
                    {contexts.map((context) => (
                      <SelectItem key={context.id} value={context.id}>
                        {context.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Select
                  value={selectedProjectKey ?? "context-only"}
                  onValueChange={(value) =>
                    selectProject(value === "context-only" ? null : (value ?? null))
                  }
                >
                  <SelectTrigger size="xs" className="w-48" aria-label="Learning project">
                    <SelectValue placeholder="Context only" />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="context-only">Context only</SelectItem>
                    {contextProjects.map((binding) => {
                      const key = `${binding.project.environmentId}:${binding.project.projectId}`;
                      return (
                        <SelectItem key={key} value={key}>
                          {binding.project.projectId} · {binding.project.environmentId}
                        </SelectItem>
                      );
                    })}
                  </SelectPopup>
                </Select>
              </>
            ) : null}
          </div>
        }
      >
        <div className="border-y border-border/60">
          <div className="grid grid-cols-3 divide-x divide-border/60 sm:grid-cols-4">
            {[
              { label: "Evidence", value: snapshot?.evidence.length ?? 0 },
              { label: "Proposals", value: snapshot?.proposals.length ?? 0 },
              { label: "Versions", value: snapshot?.versions.length ?? 0 },
              { label: "History", value: snapshot?.lifecycle.length ?? 0 },
            ].map((metric) => (
              <div key={metric.label} className="px-3 py-3 first:pl-0 sm:px-4 sm:first:pl-0">
                <p className="text-lg font-semibold tabular-nums text-foreground">{metric.value}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{metric.label}</p>
              </div>
            ))}
          </div>
          <div className="flex gap-1 overflow-x-auto border-t border-border/60 py-2">
            {[
              { id: "review" as const, label: "Review", icon: ListChecksIcon },
              { id: "evidence" as const, label: "Evidence", icon: FileTextIcon },
              { id: "versions" as const, label: "Versions", icon: CheckIcon },
              { id: "history" as const, label: "History", icon: HistoryIcon },
            ].map((tab) => {
              const Icon = tab.icon;
              return (
                <Button
                  key={tab.id}
                  type="button"
                  size="xs"
                  variant={learningView === tab.id ? "secondary" : "ghost-muted"}
                  role="tab"
                  aria-selected={learningView === tab.id}
                  onClick={() => setLearningView(tab.id)}
                >
                  <Icon />
                  {tab.label}
                </Button>
              );
            })}
          </div>
        </div>
        {query.error ? (
          <div className="flex items-center justify-between gap-3 border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive-foreground">
            <span>{query.error}</span>
            <Button size="xs" variant="outline" onClick={query.refresh}>
              Retry
            </Button>
          </div>
        ) : null}
        {connectionState === "disconnected" ? (
          <div className="border border-border/60 px-3 py-4 text-sm text-muted-foreground">
            This project is disconnected. Connect the environment to view and update Learning.
          </div>
        ) : null}
        {connectionState === "connecting" ? (
          <div className="border border-border/60 px-3 py-4 text-sm text-muted-foreground">
            Connecting to the project environment. Learning will be available when the connection is
            ready.
          </div>
        ) : null}
        {connectionState === "error" ? (
          <div className="border border-destructive/30 bg-destructive/5 px-3 py-4 text-sm text-destructive-foreground">
            The project connection is unavailable. Retry the environment connection before using
            Learning.
          </div>
        ) : null}
        {query.isPending && !snapshot ? (
          <div className="border border-border/60 px-3 py-8 text-center text-sm text-muted-foreground">
            Loading learning data...
          </div>
        ) : null}
        {learningView === "evidence" ? (
          <SettingsRow
            title="Evidence"
            description="Short, retained observations that can support a proposal. Manual entries expire after 30 days."
            status={snapshot ? `${snapshot.evidence.length} retained` : undefined}
          >
            <div className="grid gap-2 py-3 sm:grid-cols-[1fr_auto]">
              <Input
                value={evidenceSummary}
                onChange={(event) => setEvidenceSummary(event.target.value)}
                placeholder="Correction or recurring pattern"
                aria-label="Evidence summary"
              />
              <Button
                size="sm"
                disabled={busy || !writesAvailable || !evidenceSummary.trim()}
                onClick={() => void addEvidence()}
              >
                <PlusIcon /> Record
              </Button>
            </div>
            <div className="space-y-2 pb-3">
              {snapshot?.evidence.map((evidence) => (
                <div key={evidence.id} className="rounded-lg border border-border/50 p-3 text-sm">
                  <p>{evidence.summary}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {evidence.provenance.sourceKind} · observed{" "}
                    {dateLabel(evidence.provenance.observedAt)}
                  </p>
                </div>
              ))}
              {snapshot && snapshot.evidence.length === 0 ? (
                <p className="text-xs text-muted-foreground">No evidence in this context.</p>
              ) : null}
            </div>
          </SettingsRow>
        ) : null}

        {learningView === "review" ? (
          <div className="grid gap-5 xl:grid-cols-[minmax(17rem,0.75fr)_minmax(0,1.25fr)]">
            <SettingsRow
              title="New proposal"
              description="Draft a concrete change backed by evidence. Submission starts human review."
            >
              <div className="grid gap-2 py-3 sm:grid-cols-2">
                <Select
                  value={proposalKind}
                  onValueChange={(value) =>
                    value && setProposalKind(value as AxisLearningProposalKind)
                  }
                >
                  <SelectTrigger aria-label="Proposal kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {PROPOSAL_KINDS.map((kind) => (
                      <SelectItem key={kind.value} value={kind.value}>
                        {kind.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Input
                  value={proposalTarget}
                  onChange={(event) => setProposalTarget(event.target.value)}
                  placeholder="Target key, e.g. skill:review"
                  aria-label="Proposal target"
                />
                <Input
                  value={proposalTitle}
                  onChange={(event) => setProposalTitle(event.target.value)}
                  placeholder="Proposal title"
                  aria-label="Proposal title"
                />
                <Select
                  value={proposalEvidenceId || undefined}
                  onValueChange={(value) => value && setProposalEvidenceId(value)}
                >
                  <SelectTrigger aria-label="Supporting evidence">
                    <SelectValue placeholder="Supporting evidence" />
                  </SelectTrigger>
                  <SelectPopup>
                    {snapshot?.evidence.map((evidence) => (
                      <SelectItem key={evidence.id} value={evidence.id}>
                        {evidence.summary}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Textarea
                  className="sm:col-span-2"
                  value={proposalRationale}
                  onChange={(event) => setProposalRationale(event.target.value)}
                  placeholder="Why this should improve the process"
                  aria-label="Proposal rationale"
                />
                <Textarea
                  className="sm:col-span-2"
                  value={proposalChange}
                  onChange={(event) => setProposalChange(event.target.value)}
                  placeholder="Exact instruction or process change"
                  aria-label="Proposed change"
                />
                <div className="flex justify-end sm:col-span-2">
                  <Button
                    size="sm"
                    disabled={
                      busy ||
                      !writesAvailable ||
                      !proposalEvidenceId ||
                      !proposalTarget.trim() ||
                      !proposalTitle.trim() ||
                      !proposalRationale.trim() ||
                      !proposalChange.trim()
                    }
                    onClick={() => void addProposal()}
                  >
                    <PlusIcon /> Create draft
                  </Button>
                </div>
              </div>
            </SettingsRow>

            <SettingsRow
              title="Automatic analysis"
              description="Hermes runs after new project evidence is recorded and places safe candidates in the review queue."
              status={
                engineStatus?.availability === "available"
                  ? (engineStatus.engineId ?? "Available")
                  : (engineStatus?.message ?? "Not run")
              }
            >
              <div className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span className="text-sm text-muted-foreground">
                  {!learningScope
                    ? "Select a project to analyze its evidence."
                    : analysisEvidenceIds.length
                      ? `Analyzes the ${analysisEvidenceIds.length} most recent evidence records.`
                      : "No evidence is available for analysis."}
                </span>
                <Button
                  size="sm"
                  disabled={
                    busy ||
                    !learningScope ||
                    !writesAvailable ||
                    !snapshot ||
                    snapshot.evidence.length === 0
                  }
                  onClick={() => void requestLearningImprovements()}
                >
                  <SendIcon /> Analyze now
                </Button>
              </div>
            </SettingsRow>

            <SettingsRow
              title="Review queue"
              description="Submit drafts, then explicitly approve or reject proposals. Approval never activates a version."
              status={snapshot ? `${snapshot.proposals.length} proposals` : undefined}
            >
              <div className="space-y-2 py-3">
                {snapshot?.proposals.map((proposal) => (
                  <div key={proposal.id} className="rounded-lg border border-border/50 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">{proposal.title}</p>
                          <Badge
                            variant={
                              proposal.status === "approved"
                                ? "success"
                                : proposal.status === "rejected"
                                  ? "error"
                                  : "outline"
                            }
                          >
                            {proposal.status}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {proposal.kind} · {proposal.targetKey}
                        </p>
                        <p className="mt-2 text-sm text-muted-foreground">{proposal.rationale}</p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          Evidence:{" "}
                          {proposal.evidenceIds
                            .map((id) => evidenceById.get(id)?.summary ?? id)
                            .join("; ")}
                        </p>
                        {proposal.status === "in-review" ? (
                          <Input
                            className="mt-3"
                            value={reviewNotes[proposal.id] ?? ""}
                            onChange={(event) =>
                              setReviewNotes((notes) => ({
                                ...notes,
                                [proposal.id]: event.target.value,
                              }))
                            }
                            placeholder="Add a review note (optional)"
                            aria-label={`Review note for ${proposal.title}`}
                          />
                        ) : null}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        {proposal.status === "draft" ? (
                          <Button
                            size="xs"
                            disabled={busy || !writesAvailable}
                            onClick={() => void submit(proposal)}
                          >
                            <SendIcon /> Submit
                          </Button>
                        ) : null}
                        {proposal.status === "in-review" ? (
                          <>
                            <Button
                              size="xs"
                              disabled={busy || !writesAvailable}
                              onClick={() => void approve(proposal, reviewNotes[proposal.id] ?? "")}
                            >
                              <CheckIcon /> Approve
                            </Button>
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={busy || !writesAvailable}
                              onClick={() => void reject(proposal, reviewNotes[proposal.id] ?? "")}
                            >
                              <XIcon /> Reject
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
                {snapshot && snapshot.proposals.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No proposals in this context.</p>
                ) : null}
              </div>
            </SettingsRow>
          </div>
        ) : null}

        {learningView === "versions" ? (
          <SettingsRow
            title="Immutable versions"
            description="Approved snapshots remain unchanged. Activation and rollback always require confirmation."
            status={snapshot ? `${snapshot.versions.length} versions` : undefined}
          >
            <div className="space-y-2 py-3">
              {snapshot?.versions.map((version) => {
                const action = learningVersionAction(
                  version,
                  snapshot.activeVersions,
                  snapshot.versions,
                );
                return (
                  <div
                    key={version.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/50 p-3"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{version.title}</p>
                        {action === "active" ? <Badge variant="success">Active</Badge> : null}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {version.targetKey} · approved {dateLabel(version.createdAt)} by{" "}
                        {version.approvedBy}
                      </p>
                    </div>
                    {action !== "active" ? (
                      <Button
                        size="xs"
                        variant={action === "rollback" ? "outline" : "default"}
                        disabled={busy || !writesAvailable}
                        onClick={() => void applyVersion(version)}
                      >
                        {action === "rollback" ? <RotateCcwIcon /> : <CheckIcon />}
                        {action === "rollback" ? "Roll back" : "Activate"}
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy || !writesAvailable}
                        onClick={() => void deactivate(version)}
                      >
                        <XIcon /> Deactivate
                      </Button>
                    )}
                  </div>
                );
              })}
              {snapshot && snapshot.versions.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No approved versions in this context.
                </p>
              ) : null}
            </div>
          </SettingsRow>
        ) : null}

        {learningView === "history" ? (
          <SettingsRow
            title="Audit trail"
            description="Append-only lifecycle history for reviews and activation changes."
            status={snapshot ? `${snapshot.lifecycle.length} events` : undefined}
          >
            <div className="space-y-2 py-3">
              {snapshot?.lifecycle.map((event) => (
                <div key={event.id} className="flex flex-wrap justify-between gap-2 text-sm">
                  <span>
                    {event.action}
                    {event.note ? ` · ${event.note}` : ""}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {dateLabel(event.createdAt)} · {event.actor}
                  </span>
                </div>
              ))}
              {snapshot && snapshot.lifecycle.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No lifecycle events in this context.
                </p>
              ) : null}
            </div>
          </SettingsRow>
        ) : null}
      </SettingsSection>
    </div>
  );
}

import { useMemo, useRef, useState } from "react";
import { CheckIcon, PlusIcon, RotateCcwIcon, SendIcon, XIcon } from "lucide-react";

import {
  AxisLearningEvidenceId,
  CommandId,
  type AxisContextProjectScope,
  type AxisLearningEngineStatus,
  type AxisLearningProposal,
  type AxisLearningProposalKind,
  type EnvironmentId,
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
import type { AxisLearningConnectionState } from "../settings/AxisLearningSettings";
import {
  buildManualLearningEvidence,
  buildManualLearningProposal,
  learningAnalysisEvidenceIds,
} from "../settings/AxisLearningSettings.logic";
import {
  buildDeactivateInput,
  buildProjectLearningModel,
  buildVersionActionInput,
  type ProjectLearningVersionEntry,
} from "./projectLearningModel";
import { LearningProposalDetail } from "./LearningProposalDetail";

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

function entityId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function newCommandId(): CommandId {
  return CommandId.make(`axis-learning-${randomUUID().replaceAll("-", "")}`);
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function errorDescription<E>(
  result: Extract<AtomCommandResult<unknown, E>, { readonly _tag: "Failure" }>,
): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message ? error.message : "Refresh and try again.";
}

/**
 * Reviews and applies Axis Learning improvements scoped to one project. Approve
 * never activates a version, and a version only shows Active once the server's
 * observed active state confirms it — never optimistically.
 */
export function ProjectLearningPanel({
  environmentId,
  scope,
  projectLabel,
  connectionState,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: AxisContextProjectScope;
  readonly projectLabel?: string;
  readonly connectionState: AxisLearningConnectionState;
}) {
  const [busy, setBusy] = useState(false);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [evidenceSummary, setEvidenceSummary] = useState("");
  const [proposalKind, setProposalKind] =
    useState<AxisLearningProposalKind>("workflow-recommendation");
  const [proposalTarget, setProposalTarget] = useState("");
  const [proposalTitle, setProposalTitle] = useState("");
  const [proposalRationale, setProposalRationale] = useState("");
  const [proposalChange, setProposalChange] = useState("");
  const [proposalEvidenceId, setProposalEvidenceId] = useState("");
  const [engineStatus, setEngineStatus] = useState<AxisLearningEngineStatus | null>(null);
  const writesAvailable = connectionState === "connected";
  const scopeMatchesEnvironment = scope.project.environmentId === environmentId;

  /** Kept stable per pending action so a retry reuses the same commandId. */
  const commandIds = useRef(new Map<string, CommandId>());
  function commandIdFor(key: string): CommandId {
    const existing = commandIds.current.get(key);
    if (existing !== undefined) return existing;
    const created = newCommandId();
    commandIds.current.set(key, created);
    return created;
  }
  function clearCommandId(key: string) {
    commandIds.current.delete(key);
  }

  const query = useEnvironmentQuery(
    !scopeMatchesEnvironment || !writesAvailable
      ? null
      : serverEnvironment.axisLearningSnapshot({
          environmentId,
          input: { contextId: scope.contextId, scope },
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
  const model = useMemo(() => buildProjectLearningModel(scope, snapshot), [scope, snapshot]);
  const analysisEvidenceIds = useMemo(
    () => learningAnalysisEvidenceIds(snapshot?.evidence ?? []),
    [snapshot],
  );
  const evidenceById = useMemo(
    () => new Map(snapshot?.evidence.map((evidence) => [evidence.id, evidence]) ?? []),
    [snapshot],
  );

  async function finish<A, E>(result: AtomCommandResult<A, E>, successTitle: string, key?: string) {
    setBusy(false);
    if (result._tag === "Success") {
      if (key !== undefined) clearCommandId(key);
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
    if (!writesAvailable || busy || !evidenceSummary.trim()) return;
    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + 30);
    setBusy(true);
    const saved = await finish(
      await recordEvidence({
        environmentId,
        input: {
          evidence: buildManualLearningEvidence({
            contextId: scope.contextId,
            scope,
            id: entityId("learning_evidence"),
            sourceId: "project-learning-panel",
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
            contextId: scope.contextId,
            scope,
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
      await submitProposal({ environmentId, input: { id: proposal.id, scope } }),
      "Proposal submitted for review",
    );
  }

  async function approve(proposal: AxisLearningProposal) {
    if (busy || !writesAvailable) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Approve "${proposal.title}"? Approval creates an immutable version, but does not activate it.`,
    );
    if (!confirmed) return;
    setBusy(true);
    const note = reviewNotes[proposal.id] ?? "";
    await finish(
      await approveProposal({
        environmentId,
        input: { id: proposal.id, scope, ...(note.trim() ? { note: note.trim() } : {}) },
      }),
      "Proposal approved; activation is still required",
    );
  }

  async function reject(proposal: AxisLearningProposal) {
    if (busy) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Reject "${proposal.title}"? The proposal and review record will be retained.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setBusy(true);
    const note = reviewNotes[proposal.id] ?? "";
    await finish(
      await rejectProposal({
        environmentId,
        input: { id: proposal.id, scope, ...(note.trim() ? { note: note.trim() } : {}) },
      }),
      "Proposal rejected",
    );
  }

  async function applyVersion(entry: ProjectLearningVersionEntry) {
    if (busy || !writesAvailable || entry.action === "active") return;
    const key = `${entry.action}:${entry.version.id}`;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      entry.action === "activate"
        ? `Activate "${entry.version.title}"? This is an explicit change to the active learning version.`
        : `Roll back to "${entry.version.title}"? The current version remains in the immutable history.`,
      entry.action === "rollback" ? { variant: "destructive" } : undefined,
    );
    if (!confirmed) return;
    const result = buildVersionActionInput(entry, commandIdFor(key));
    if (!result.ok) {
      toastManager.add({ type: "error", title: result.reason });
      return;
    }
    setBusy(true);
    await finish(
      entry.action === "activate"
        ? await activateVersion({ environmentId, input: result.input })
        : await rollbackVersion({ environmentId, input: result.input }),
      entry.action === "activate" ? "Version activated" : "Version rolled back",
      key,
    );
  }

  async function deactivate(entry: ProjectLearningVersionEntry) {
    if (busy || !writesAvailable || entry.action !== "active") return;
    const key = `deactivate:${entry.version.id}`;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Deactivate "${entry.version.title}"? The approved version will remain in history.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    const result = buildDeactivateInput(entry, commandIdFor(key));
    if (!result.ok) {
      toastManager.add({ type: "error", title: result.reason });
      return;
    }
    setBusy(true);
    await finish(
      await deactivateVersion({ environmentId, input: result.input }),
      "Version deactivated",
      key,
    );
  }

  async function requestLearningImprovements() {
    if (!writesAvailable || busy || !snapshot || snapshot.evidence.length === 0) return;
    setBusy(true);
    const result = await requestImprovements({
      environmentId,
      input: {
        scope,
        evidenceIds: analysisEvidenceIds,
        commandId: newCommandId(),
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

  if (!scopeMatchesEnvironment) {
    return (
      <SettingsSection title="Learning">
        <SettingsRow
          title="Project environment mismatch"
          description="The selected physical project belongs to another environment."
        />
      </SettingsSection>
    );
  }
  if (connectionState === "disconnected" || connectionState === "connecting") {
    return (
      <SettingsSection title="Learning">
        <SettingsRow
          title={connectionState === "connecting" ? "Connecting" : "Project disconnected"}
          description={
            connectionState === "connecting"
              ? "Connecting to the project environment. Learning will be available when the connection is ready."
              : "Connect the environment to view and update Learning."
          }
        />
      </SettingsSection>
    );
  }
  if (connectionState === "error") {
    return (
      <SettingsSection title="Learning">
        <SettingsRow
          title="Connection unavailable"
          description="The project connection is unavailable. Retry the environment connection before using Learning."
        />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title="Learning"
      description={`Review evidence and proposed improvements for ${projectLabel ?? scope.project.projectId}. Nothing activates automatically.`}
      variant="plain"
      className="space-y-5"
    >
      {query.error ? (
        <div className="flex items-center justify-between gap-3 border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive-foreground">
          <span>{query.error}</span>
          <Button size="xs" variant="outline" onClick={query.refresh}>
            Retry
          </Button>
        </div>
      ) : null}
      {query.isPending && !snapshot ? (
        <div className="border border-border/60 px-3 py-8 text-center text-sm text-muted-foreground">
          Loading learning data...
        </div>
      ) : null}

      <SettingsRow
        title="Evidence"
        description="Short, retained observations that can support a proposal. Manual entries expire after 30 days."
        status={`${model.evidenceCount} retained`}
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
      </SettingsRow>

      <SettingsRow
        title="Engine analysis"
        description="Analyze retained project evidence and place safe candidates in the review queue."
        status={
          engineStatus?.availability === "available"
            ? (engineStatus.engineId ?? "Available")
            : (engineStatus?.message ?? "Not run")
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-3 py-3">
          <span className="text-sm text-muted-foreground">
            {analysisEvidenceIds.length
              ? `Analyzes the ${analysisEvidenceIds.length} most recent evidence records.`
              : "No evidence is available for analysis."}
          </span>
          <Button
            size="sm"
            disabled={busy || !writesAvailable || !snapshot || snapshot.evidence.length === 0}
            onClick={() => void requestLearningImprovements()}
          >
            <SendIcon /> Request analysis
          </Button>
        </div>
      </SettingsRow>

      <SettingsRow
        title="New proposal"
        description="Draft a concrete change backed by evidence. Submission starts human review."
      >
        <div className="grid gap-2 py-3 sm:grid-cols-2">
          <Select
            value={proposalKind}
            onValueChange={(value) => value && setProposalKind(value as AxisLearningProposalKind)}
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
        title="Review queue"
        description="Submit drafts, then explicitly approve or reject proposals. Approval never activates a version."
        status={`${model.proposalsByStatus.draft.length + model.proposalsByStatus["in-review"].length + model.proposalsByStatus.approved.length + model.proposalsByStatus.rejected.length} proposals`}
      >
        <div className="space-y-2 py-3">
          {[
            ...model.proposalsByStatus.draft,
            ...model.proposalsByStatus["in-review"],
            ...model.proposalsByStatus.approved,
            ...model.proposalsByStatus.rejected,
          ].map((proposal) => (
            <LearningProposalDetail
              key={proposal.id}
              proposal={proposal}
              evidenceById={evidenceById}
              reviewNote={reviewNotes[proposal.id] ?? ""}
              onReviewNoteChange={(value) =>
                setReviewNotes((notes) => ({ ...notes, [proposal.id]: value }))
              }
              busy={busy}
              writesAvailable={writesAvailable}
              onSubmit={() => void submit(proposal)}
              onApprove={() => void approve(proposal)}
              onReject={() => void reject(proposal)}
            />
          ))}
          {model.proposalsByStatus.draft.length +
            model.proposalsByStatus["in-review"].length +
            model.proposalsByStatus.approved.length +
            model.proposalsByStatus.rejected.length ===
          0 ? (
            <p className="text-xs text-muted-foreground">No proposals for this project.</p>
          ) : null}
        </div>
      </SettingsRow>

      <SettingsRow
        title="Immutable versions"
        description="Approved snapshots remain unchanged. Activation and rollback always require confirmation."
        status={`${model.versionEntries.length} versions`}
      >
        <div className="space-y-2 py-3">
          {model.versionEntries.map((entry) => (
            <div
              key={entry.version.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/50 p-3"
            >
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{entry.version.title}</p>
                  {entry.action === "active" ? <Badge variant="success">Active</Badge> : null}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  approved {dateLabel(entry.version.createdAt)} by {entry.version.approvedBy}
                </p>
              </div>
              {entry.action !== "active" ? (
                <Button
                  size="xs"
                  variant={entry.action === "rollback" ? "outline" : "default"}
                  disabled={busy || !writesAvailable}
                  onClick={() => void applyVersion(entry)}
                >
                  {entry.action === "rollback" ? <RotateCcwIcon /> : <CheckIcon />}
                  {entry.action === "rollback" ? "Roll back" : "Activate"}
                </Button>
              ) : (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || !writesAvailable}
                  onClick={() => void deactivate(entry)}
                >
                  <XIcon /> Deactivate
                </Button>
              )}
            </div>
          ))}
          {model.versionEntries.length === 0 ? (
            <p className="text-xs text-muted-foreground">No approved versions for this project.</p>
          ) : null}
        </div>
      </SettingsRow>

      <SettingsRow
        title="Audit trail"
        description="Append-only lifecycle history for reviews and activation changes."
        status={`${model.history.length} events`}
      >
        <div className="space-y-2 py-3">
          {model.history.map((entry) => (
            <div key={entry.event.id} className="flex flex-wrap justify-between gap-2 text-sm">
              <span>
                {entry.label}
                {entry.versionTitle ? ` · ${entry.versionTitle}` : ""}
                {entry.previousVersionTitle ? ` (from ${entry.previousVersionTitle})` : ""}
                {entry.event.note ? ` · ${entry.event.note}` : ""}
              </span>
              <span className="text-xs text-muted-foreground">
                {dateLabel(entry.event.createdAt)} · {entry.event.actor}
              </span>
            </div>
          ))}
          {model.history.length === 0 ? (
            <p className="text-xs text-muted-foreground">No lifecycle events for this project.</p>
          ) : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

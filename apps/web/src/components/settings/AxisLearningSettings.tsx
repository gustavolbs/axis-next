import { useMemo, useState } from "react";
import { CheckIcon, PlusIcon, RotateCcwIcon, SendIcon, XIcon } from "lucide-react";

import {
  AxisContextId,
  AxisLearningEvidenceId,
  type AxisContext,
  type AxisLearningProposal,
  type AxisLearningProposalKind,
  type AxisLearningVersion,
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
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  buildManualLearningEvidence,
  buildManualLearningProposal,
  learningVersionAction,
} from "./AxisLearningSettings.logic";

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

export function AxisLearningSettings({
  environmentId,
  contexts,
}: {
  readonly environmentId: EnvironmentId;
  readonly contexts: ReadonlyArray<AxisContext>;
}) {
  const [selectedContextId, setSelectedContextId] = useState<AxisContextId | null>(
    contexts[0]?.id ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [evidenceSummary, setEvidenceSummary] = useState("");
  const [proposalKind, setProposalKind] =
    useState<AxisLearningProposalKind>("workflow-recommendation");
  const [proposalTarget, setProposalTarget] = useState("");
  const [proposalTitle, setProposalTitle] = useState("");
  const [proposalRationale, setProposalRationale] = useState("");
  const [proposalChange, setProposalChange] = useState("");
  const [proposalEvidenceId, setProposalEvidenceId] = useState("");

  const contextId =
    selectedContextId !== null && contexts.some((context) => context.id === selectedContextId)
      ? selectedContextId
      : (contexts[0]?.id ?? null);

  const query = useEnvironmentQuery(
    contextId === null
      ? null
      : serverEnvironment.axisLearningSnapshot({ environmentId, input: { contextId } }),
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

  const snapshot = query.data;
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
    if (contextId === null || busy || !evidenceSummary.trim()) return;
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
    if (busy) return;
    setBusy(true);
    await finish(
      await submitProposal({ environmentId, input: { id: proposal.id } }),
      "Proposal submitted for review",
    );
  }

  async function approve(proposal: AxisLearningProposal) {
    if (busy) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Approve “${proposal.title}”? Approval creates an immutable version, but does not activate it.`,
    );
    if (!confirmed) return;
    setBusy(true);
    await finish(
      await approveProposal({
        environmentId,
        input: { id: proposal.id, ...(reviewNote.trim() ? { note: reviewNote.trim() } : {}) },
      }),
      "Proposal approved; activation is still required",
    );
  }

  async function reject(proposal: AxisLearningProposal) {
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
        input: { id: proposal.id, ...(reviewNote.trim() ? { note: reviewNote.trim() } : {}) },
      }),
      "Proposal rejected",
    );
  }

  async function applyVersion(version: AxisLearningVersion) {
    if (!snapshot || busy) return;
    const action = learningVersionAction(version, snapshot.activeVersions, snapshot.versions);
    if (action === "active") return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      action === "activate"
        ? `Activate “${version.title}” for ${version.targetKey}? This is an explicit change to the active learning version.`
        : `Roll back ${version.targetKey} to “${version.title}”? The current version remains in the immutable history.`,
      action === "rollback" ? { variant: "destructive" } : undefined,
    );
    if (!confirmed) return;
    setBusy(true);
    await finish(
      action === "activate"
        ? await activateVersion({ environmentId, input: { id: version.id } })
        : await rollbackVersion({ environmentId, input: { id: version.id } }),
      action === "activate" ? "Version activated" : "Version rolled back",
    );
  }

  return (
    <SettingsSection
      id="axis-learning"
      title="Axis Learning"
      description="Review evidence and proposed improvements per context. Nothing activates automatically."
      headerAction={
        <Select
          value={contextId ?? undefined}
          onValueChange={(value) => value && setSelectedContextId(AxisContextId.make(value))}
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
      }
    >
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
            disabled={busy || !evidenceSummary.trim()}
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
        status={snapshot ? `${snapshot.proposals.length} proposals` : undefined}
      >
        <div className="space-y-2 py-3">
          <Input
            value={reviewNote}
            onChange={(event) => setReviewNote(event.target.value)}
            placeholder="Optional note for the next approval or rejection"
            aria-label="Review note"
          />
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
                </div>
                <div className="flex shrink-0 gap-2">
                  {proposal.status === "draft" ? (
                    <Button size="xs" disabled={busy} onClick={() => void submit(proposal)}>
                      <SendIcon /> Submit
                    </Button>
                  ) : null}
                  {proposal.status === "in-review" ? (
                    <>
                      <Button size="xs" disabled={busy} onClick={() => void approve(proposal)}>
                        <CheckIcon /> Approve
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void reject(proposal)}
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
                    disabled={busy}
                    onClick={() => void applyVersion(version)}
                  >
                    {action === "rollback" ? <RotateCcwIcon /> : <CheckIcon />}
                    {action === "rollback" ? "Roll back" : "Activate"}
                  </Button>
                ) : null}
              </div>
            );
          })}
          {snapshot && snapshot.versions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No approved versions in this context.</p>
          ) : null}
        </div>
      </SettingsRow>

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
            <p className="text-xs text-muted-foreground">No lifecycle events in this context.</p>
          ) : null}
          {query.error ? (
            <div className="flex items-center justify-between gap-3 text-sm text-destructive-foreground">
              <span>{query.error}</span>
              <Button size="xs" variant="outline" onClick={query.refresh}>
                Retry
              </Button>
            </div>
          ) : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

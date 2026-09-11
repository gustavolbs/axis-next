import { useEffect, useMemo, useState } from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  OctagonAlertIcon,
  RefreshCwIcon,
  XCircleIcon,
} from "lucide-react";

import type { AxisContextProjectScope } from "@t3tools/contracts";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import {
  buildProjectOnboardingModel,
  setProjectOnboardingDecision,
  type ProjectOnboardingCandidateRule,
  type ProjectOnboardingConnectionState,
  type ProjectOnboardingDecision,
  type ProjectOnboardingOperation,
  type ProjectOnboardingProgress,
  type ProjectOnboardingQuery,
  type ProjectOnboardingRevisionConflict,
} from "./projectOnboardingModel";

type AsyncCommand = () => void | Promise<unknown>;

export interface ProjectOnboardingCommands {
  readonly analyze: AsyncCommand;
  readonly cancel: AsyncCommand;
  readonly retry: AsyncCommand;
  readonly reconnect: AsyncCommand;
  readonly apply: (decisions: ReadonlyArray<ProjectOnboardingDecision>) => void | Promise<unknown>;
}

export interface ProjectOnboardingPanelProps {
  readonly scope: AxisContextProjectScope;
  readonly query: ProjectOnboardingQuery;
  readonly analysisAvailable?: boolean;
  readonly profileRevision: number | null;
  readonly connectionState: ProjectOnboardingConnectionState;
  readonly commands: ProjectOnboardingCommands;
  readonly projectLabel?: string;
  readonly progress?: ProjectOnboardingProgress | null;
  readonly operation?: ProjectOnboardingOperation;
  readonly error?: string | null;
  readonly revisionConflict?: ProjectOnboardingRevisionConflict | null;
  readonly onDecisionChange?: (decision: ProjectOnboardingDecision) => void;
}

const categoryLabel = (candidate: ProjectOnboardingCandidateRule): string => {
  switch (candidate.category) {
    case "pull-request-policy":
      return "Pull request policy";
    case "test-policy":
      return "Test policy";
    case "instruction":
      return "Instruction";
    case "command":
      return "Command";
    case "convention":
      return "Convention";
    case "path":
      return "Path rule";
    case "tool":
      return "Tool rule";
  }
};

const phaseLabel = (phase: ReturnType<typeof buildProjectOnboardingModel>["phase"]): string => {
  switch (phase) {
    case "idle":
      return "Ready to analyze";
    case "analyzing":
      return "Analyzing project";
    case "review":
      return "Ready for review";
    case "applying":
      return "Applying decisions";
    case "cancelling":
      return "Cancelling analysis";
    case "cancelled":
      return "Analysis cancelled";
    case "failed":
      return "Analysis failed";
    case "reconnecting":
      return "Reconnecting";
    case "revision-conflict":
      return "Profile changed";
    case "applied":
      return "Decisions applied";
  }
};

function PhaseIcon({
  phase,
}: {
  readonly phase: ReturnType<typeof buildProjectOnboardingModel>["phase"];
}) {
  const Icon =
    phase === "failed" || phase === "revision-conflict"
      ? AlertCircleIcon
      : phase === "cancelled" || phase === "cancelling"
        ? XCircleIcon
        : phase === "applied"
          ? CheckCircle2Icon
          : phase === "analyzing" || phase === "applying" || phase === "reconnecting"
            ? LoaderCircleIcon
            : CircleDashedIcon;
  return <Icon aria-hidden className="size-4" />;
}

function DecisionRow({
  candidate,
  decision,
  disabled,
  onChange,
}: {
  readonly candidate: ProjectOnboardingCandidateRule;
  readonly decision: ProjectOnboardingDecision | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: ProjectOnboardingDecision["decision"], note: string | null) => void;
}) {
  return (
    <div className="grid gap-3 border-b border-border/50 px-3 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_10rem] sm:px-4">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{categoryLabel(candidate)}</Badge>
          <span className="text-xs text-muted-foreground">Detected candidate</span>
        </div>
        <p className="text-sm leading-5 text-foreground">{candidate.text}</p>
        <Textarea
          size="sm"
          value={decision?.note ?? ""}
          disabled={disabled || decision === undefined}
          placeholder={decision === undefined ? "Choose a decision first" : "Optional note"}
          aria-label={`Note for ${candidate.text}`}
          onChange={(event) => onChange(decision?.decision ?? "defer", event.target.value || null)}
        />
      </div>
      <Select
        value={decision?.decision ?? undefined}
        disabled={disabled}
        onValueChange={(value) => {
          if (value === "accept" || value === "reject" || value === "defer") {
            onChange(value, decision?.note ?? null);
          }
        }}
      >
        <SelectTrigger aria-label={`Decision for ${candidate.text}`}>
          <SelectValue placeholder="Choose decision" />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="accept">Accept</SelectItem>
          <SelectItem value="reject">Reject</SelectItem>
          <SelectItem value="defer">Defer</SelectItem>
        </SelectPopup>
      </Select>
    </div>
  );
}

export function ProjectOnboardingPanel({
  scope,
  query,
  analysisAvailable,
  profileRevision,
  connectionState,
  commands,
  projectLabel = "Project",
  progress = null,
  operation = null,
  error = null,
  revisionConflict = null,
  onDecisionChange,
}: ProjectOnboardingPanelProps) {
  const [decisions, setDecisions] = useState<ReadonlyArray<ProjectOnboardingDecision>>(
    query.data?.decisions ?? [],
  );
  const serverDecisionKey = JSON.stringify(query.data?.decisions ?? []);
  const [pendingOperation, setPendingOperation] = useState<ProjectOnboardingOperation>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const runCommand = async (
    next: Exclude<ProjectOnboardingOperation, "applied" | null>,
    command: AsyncCommand,
  ) => {
    if (pendingOperation !== null && pendingOperation !== "applied") return;
    setPendingOperation(next);
    setCommandError(null);
    try {
      await command();
      setPendingOperation(next === "apply" ? "applied" : null);
    } catch (cause) {
      setCommandError(
        cause instanceof Error ? cause.message : "The operation failed. Refresh and try again.",
      );
      setPendingOperation(null);
    }
  };

  useEffect(() => {
    setDecisions(query.data?.decisions ?? []);
  }, [query.data?.id, serverDecisionKey]);

  const model = useMemo(
    () =>
      buildProjectOnboardingModel({
        scope,
        run: query.data,
        analysisAvailable: analysisAvailable ?? true,
        connectionState,
        profileRevision,
        progress,
        operation: pendingOperation ?? operation,
        error: commandError ?? error ?? query.error,
        revisionConflict,
        decisions,
      }),
    [
      analysisAvailable,
      commandError,
      connectionState,
      decisions,
      error,
      operation,
      pendingOperation,
      profileRevision,
      progress,
      query.data,
      query.error,
      revisionConflict,
      scope,
    ],
  );

  const updateDecision = (
    candidate: ProjectOnboardingCandidateRule,
    value: ProjectOnboardingDecision["decision"],
    note: string | null,
  ) => {
    const next = setProjectOnboardingDecision(decisions, candidate.id, value, note);
    setDecisions((current) => {
      const existing = current.findIndex(
        (decision) => decision.candidateRuleId === next.candidateRuleId,
      );
      return existing === -1
        ? [...current, next]
        : current.map((decision, index) => (index === existing ? next : decision));
    });
    onDecisionChange?.(next);
  };

  const busy =
    model.phase === "analyzing" ||
    model.phase === "applying" ||
    model.phase === "cancelling" ||
    model.phase === "reconnecting";
  const sourceCount = model.run?.sources.length ?? 0;

  return (
    <div className="space-y-5">
      <SettingsSection
        title={`${projectLabel} onboarding`}
        description="Review what Axis found in the selected project before changing its profile."
        variant="plain"
        headerAction={
          <div className="flex items-center gap-2">
            <Badge variant={model.connectionState === "connected" ? "success" : "warning"}>
              {model.connectionLabel}
            </Badge>
            {model.canReconnect ? (
              <Button
                size="xs"
                variant="outline"
                disabled={pendingOperation === "reconnect"}
                onClick={() => void runCommand("reconnect", commands.reconnect)}
              >
                <RefreshCwIcon />
                Reconnect
              </Button>
            ) : null}
          </div>
        }
      >
        <SettingsRow
          title={
            model.phase === "idle" && analysisAvailable === false
              ? "Analysis unavailable"
              : phaseLabel(model.phase)
          }
          description={
            model.error ??
            `${sourceCount} permitted source${sourceCount === 1 ? "" : "s"} in this run.`
          }
          status={
            <span className="inline-flex items-center gap-1.5">
              <PhaseIcon phase={model.phase} />
              {model.phase === "revision-conflict" && model.revisionConflict
                ? `Expected revision ${model.revisionConflict.expected}; current revision ${model.revisionConflict.actual}`
                : model.phase === "review"
                  ? `${model.pendingDecisions.length} decision${model.pendingDecisions.length === 1 ? "" : "s"} pending`
                  : null}
            </span>
          }
          control={
            model.canAnalyze ? (
              <Button
                size="xs"
                disabled={busy || query.isPending}
                onClick={() => void runCommand("analyze", commands.analyze)}
              >
                <GitBranchIcon />
                Analyze project
              </Button>
            ) : model.canRetry ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void runCommand("retry", commands.retry)}
              >
                <RefreshCwIcon />
                Retry
              </Button>
            ) : model.canCancel ? (
              <Button
                size="xs"
                variant="outline"
                disabled={pendingOperation !== null}
                onClick={() => void runCommand("cancel", commands.cancel)}
              >
                <XCircleIcon />
                Cancel
              </Button>
            ) : undefined
          }
        />

        {query.isPending && query.data === null ? (
          <SettingsRow
            title="Loading onboarding"
            description="Waiting for the project snapshot."
            status="Loading"
          />
        ) : null}
        {query.error ? (
          <SettingsRow
            title="Could not load onboarding"
            description={query.error}
            control={
              <Button size="xs" variant="outline" onClick={query.refresh}>
                <RefreshCwIcon />
                Refresh
              </Button>
            }
          />
        ) : null}
        {model.phase === "applied" ? (
          <SettingsRow
            title="Decisions applied"
            description="The project profile accepted the reviewed onboarding decisions."
            status="Saved"
          />
        ) : null}
        {model.phase === "failed" || model.phase === "revision-conflict" ? (
          <SettingsRow
            title={
              model.phase === "revision-conflict"
                ? "Profile revision conflict"
                : "Onboarding failed"
            }
            description={model.error ?? "No changes were applied."}
            status={
              <span className="inline-flex items-center gap-1.5 text-destructive-foreground">
                <OctagonAlertIcon className="size-3.5" /> No changes applied
              </span>
            }
          />
        ) : null}
      </SettingsSection>

      {analysisAvailable === false ? (
        <SettingsSection title="Onboarding execution">
          <SettingsRow
            title="Starting a new analysis is unavailable"
            description="Choose an available default model in Project settings before starting an analysis. Existing analyses remain available for review."
            status="Unavailable"
          />
        </SettingsSection>
      ) : null}

      {model.progress ? (
        <SettingsSection title="Progress" description={model.progress.label}>
          <SettingsRow
            title={`${model.progress.completed} of ${model.progress.total} steps`}
            description="Progress comes from the onboarding execution."
            status={model.progressPercent === null ? "In progress" : `${model.progressPercent}%`}
          >
            {model.progressPercent !== null ? (
              <div
                className="h-1.5 overflow-hidden rounded-full bg-muted"
                aria-label="Onboarding progress"
              >
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{ width: `${model.progressPercent}%` }}
                />
              </div>
            ) : null}
          </SettingsRow>
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="Permitted sources"
        description="Only these project sources are included in the onboarding run."
      >
        {model.sources.length === 0 ? (
          <SettingsRow
            title="No sources recorded"
            description="The run has not collected project sources yet."
          />
        ) : (
          model.sources.map((source) => (
            <SettingsRow
              key={source.path}
              title={source.path}
              description={source.error ?? source.warning}
              status={
                source.status === "read"
                  ? "Read"
                  : source.status === "absent"
                    ? "Not present"
                    : "Could not read"
              }
            />
          ))
        )}
      </SettingsSection>

      {model.conflicts.length > 0 ? (
        <SettingsSection
          title="Divergences"
          description="These findings need an explicit decision before they can affect the project profile."
          icon={<AlertCircleIcon className="size-4 text-warning-foreground" />}
        >
          {model.conflicts.map((conflict) => (
            <SettingsRow
              key={conflict.id}
              title="Conflicting findings"
              description={conflict.description}
            />
          ))}
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="Detected candidates"
        description="Candidates are evidence from this run, not active project rules."
      >
        {model.candidates.length === 0 ? (
          <SettingsRow
            title="No candidates yet"
            description="Analyze the project to inspect permitted sources."
          />
        ) : (
          model.candidates.map((candidate) => (
            <DecisionRow
              key={candidate.id}
              candidate={candidate}
              decision={model.manualDecisions.find(
                (decision) => decision.candidateRuleId === candidate.id,
              )}
              disabled={!model.scopeMatches || model.phase !== "review"}
              onChange={(value, note) => updateDecision(candidate, value, note)}
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection
        title="Manual decisions"
        description="Your decisions remain separate from the detected candidates until you apply them."
      >
        {model.manualDecisions.length === 0 ? (
          <SettingsRow
            title="No decisions recorded"
            description="Choose Accept, Reject, or Defer for each candidate."
          />
        ) : (
          model.manualDecisions.map((decision) => {
            const candidate = model.candidates.find((item) => item.id === decision.candidateRuleId);
            return candidate ? (
              <SettingsRow
                key={decision.id}
                title={candidate.text}
                description={decision.note ?? "No note added."}
                status={decision.decision[0]!.toUpperCase() + decision.decision.slice(1)}
              />
            ) : null;
          })
        )}
        <SettingsRow
          title="Apply reviewed decisions"
          description={
            model.canApply
              ? "Only these explicit decisions will update the project profile."
              : "Complete every candidate decision while connected before applying."
          }
          control={
            <Button
              size="xs"
              disabled={!model.canApply}
              onClick={() => void runCommand("apply", () => commands.apply(model.manualDecisions))}
            >
              <CheckCircle2Icon />
              Apply decisions
            </Button>
          }
        />
      </SettingsSection>
    </div>
  );
}

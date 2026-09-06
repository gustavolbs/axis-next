import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  CircleAlertIcon,
  HistoryIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";

import {
  AxisScheduledActivityId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  type EnvironmentId,
  type AxisContextCatalog,
  type AxisContextId,
  type AxisScheduledActivity,
  type AxisScheduledActivityDraft,
  type AxisScheduledActivityRun,
  type AxisWorkHubSourceId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { randomUUID } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  formatScheduledActivitySchedule,
  resolveScheduledAgentTargets,
  validateScheduledActivityForm,
  WEEKDAY_LABELS,
} from "./WorkHubScheduledActivities.logic";

type EditorState = {
  readonly activity: AxisScheduledActivity | null;
  readonly name: string;
  readonly contextId: AxisContextId;
  readonly actionKind: "workHubSync" | "agentTurn";
  readonly sourceIds: ReadonlyArray<AxisWorkHubSourceId>;
  readonly projectId: string;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly threadTitle: string;
  readonly prompt: string;
  readonly scheduleKind: "interval" | "weekly";
  readonly everyHours: number;
  readonly daysOfWeek: ReadonlyArray<number>;
  readonly localTime: string;
  readonly timezone: string;
  readonly enabled: boolean;
};

function activityDraft(activity: AxisScheduledActivity): AxisScheduledActivityDraft {
  return {
    id: activity.id,
    name: activity.name,
    contextId: activity.contextId,
    action: activity.action,
    schedule: activity.schedule,
    enabled: activity.enabled,
  };
}

function statusVariant(status: AxisScheduledActivity["lastRunStatus"]) {
  if (status === "failed") return "destructive" as const;
  if (status === "succeeded") return "secondary" as const;
  return "outline" as const;
}

function activityEditorState(
  catalog: AxisContextCatalog,
  environmentId: EnvironmentId,
  activity: AxisScheduledActivity | null,
): EditorState | null {
  const context = activity
    ? catalog.contexts.find((candidate) => candidate.id === activity.contextId)
    : catalog.contexts.find(
        (candidate) =>
          catalog.workHubSources.some(
            (source) =>
              source.enabled &&
              source.contextId === candidate.id &&
              source.provider.environmentId === environmentId,
          ) ||
          catalog.projectBindings.some(
            (binding) =>
              binding.contextId === candidate.id && binding.project.environmentId === environmentId,
          ),
      );
  if (!context) return null;
  const availableSourceIds = catalog.workHubSources
    .filter(
      (source) =>
        source.enabled &&
        source.contextId === context.id &&
        source.provider.environmentId === environmentId,
    )
    .map((source) => source.id);
  const availableSourceIdSet = new Set(availableSourceIds);
  const targets = resolveScheduledAgentTargets({ catalog, contextId: context.id, environmentId });
  const defaultProject = targets.projects[0]?.projectId;
  const defaultProvider = targets.providers[0]?.instanceId;
  return {
    activity,
    name: activity?.name ?? "Work Hub sync",
    contextId: context.id,
    actionKind: activity?.action.kind ?? "workHubSync",
    // A source may have been disabled or moved since the activity was
    // created. Do not keep an invisible stale selection in the editor.
    sourceIds:
      activity?.action.kind === "workHubSync"
        ? activity.action.sourceIds.filter((sourceId) => availableSourceIdSet.has(sourceId))
        : availableSourceIds,
    projectId:
      activity?.action.kind === "agentTurn"
        ? activity.action.project.projectId
        : (defaultProject ?? ""),
    providerInstanceId:
      activity?.action.kind === "agentTurn"
        ? activity.action.provider.instanceId
        : (defaultProvider ?? ""),
    model: activity?.action.kind === "agentTurn" ? activity.action.model : "",
    threadTitle: activity?.action.kind === "agentTurn" ? activity.action.title : "",
    prompt: activity?.action.kind === "agentTurn" ? activity.action.prompt : "",
    scheduleKind: activity?.schedule.kind ?? "interval",
    everyHours: activity?.schedule.kind === "interval" ? activity.schedule.everyMinutes / 60 : 8,
    daysOfWeek:
      activity?.schedule.kind === "weekly" ? activity.schedule.daysOfWeek : [1, 2, 3, 4, 5],
    localTime: activity?.schedule.kind === "weekly" ? activity.schedule.localTime : "09:00",
    timezone:
      activity?.schedule.kind === "weekly"
        ? activity.schedule.timezone
        : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    enabled: activity?.enabled ?? true,
  };
}

function sourceLabel(catalog: AxisContextCatalog, sourceId: AxisWorkHubSourceId): string {
  const source = catalog.workHubSources.find((candidate) => candidate.id === sourceId);
  const capability = source
    ? catalog.capabilities.find((candidate) => candidate.id === source.capabilityId)
    : null;
  return capability?.name ?? sourceId;
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

function ScheduledActivityRunsDialog({
  activity,
  environmentId,
  onClose,
}: {
  readonly activity: AxisScheduledActivity;
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.axisScheduledActivityRuns({
      environmentId,
      input: { activityId: activity.id, limit: 20 },
    }),
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Run history</DialogTitle>
          <DialogDescription>{activity.name}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="pb-6">
          {!query.data ? (
            <p className="text-sm text-muted-foreground">
              {query.error ? "Could not load run history." : "Loading run history…"}
            </p>
          ) : query.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">This activity has not run yet.</p>
          ) : (
            <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
              {query.data.map((run: AxisScheduledActivityRun) => (
                <div key={run.id} className="p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
                    <Badge variant="outline">{run.trigger}</Badge>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {formatTimestamp(run.startedAt)}
                    </span>
                  </div>
                  {run.message ? (
                    <p className="mt-2 text-xs text-muted-foreground">{run.message}</p>
                  ) : null}
                  {run.sourceResults.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {run.sourceResults.map((result) => (
                        <Badge key={result.sourceId} variant="outline">
                          {result.status} · {result.itemCount} items
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  {run.threadId ? (
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="truncate font-mono text-muted-foreground">
                        {run.threadId}
                      </span>
                      <Link
                        to="/$environmentId/$threadId"
                        params={{ environmentId, threadId: run.threadId }}
                        onClick={onClose}
                        className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline"
                      >
                        Open Thread
                      </Link>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function ScheduledActivityEditor({
  catalog,
  environmentId,
  initial,
  saving,
  onSave,
  onClose,
}: {
  readonly catalog: AxisContextCatalog;
  readonly environmentId: EnvironmentId;
  readonly initial: EditorState;
  readonly saving: boolean;
  readonly onSave: (draft: AxisScheduledActivityDraft) => void;
  readonly onClose: () => void;
}) {
  const [form, setForm] = useState(initial);
  const projects = useProjects();
  const sources = catalog.workHubSources.filter(
    (source) =>
      source.enabled &&
      source.contextId === form.contextId &&
      source.provider.environmentId === environmentId,
  );
  const remoteSourceCount = catalog.workHubSources.filter(
    (source) =>
      source.enabled &&
      source.contextId === form.contextId &&
      source.provider.environmentId !== environmentId,
  ).length;
  const agentTargets = resolveScheduledAgentTargets({
    catalog,
    contextId: form.contextId,
    environmentId,
  });
  const boundProjects = agentTargets.projects.flatMap((projectLocator) => {
    const project = projects.find(
      (candidate) =>
        candidate.environmentId === projectLocator.environmentId &&
        candidate.id === projectLocator.projectId,
    );
    return project ? [project] : [];
  });
  const availableProviders = agentTargets.providers;
  const validationError = validateScheduledActivityForm({
    ...form,
    availableProjectIds: boundProjects.map((project) => project.id),
    availableProviderInstanceIds: availableProviders.map((provider) => provider.instanceId),
  });
  const submit = () => {
    if (validationError) return;
    const now = new Date().toISOString();
    const previousAgentAction =
      form.activity?.action.kind === "agentTurn" ? form.activity.action : null;
    const previousInterval =
      form.activity?.schedule.kind === "interval" ? form.activity.schedule : null;
    const everyMinutes = form.everyHours * 60;
    onSave({
      id:
        form.activity?.id ??
        AxisScheduledActivityId.make(`scheduled_${randomUUID().replaceAll("-", "")}`),
      name: form.name.trim(),
      contextId: form.contextId,
      action:
        form.actionKind === "workHubSync"
          ? { kind: "workHubSync", sourceIds: [...form.sourceIds] }
          : {
              kind: "agentTurn",
              project: { environmentId, projectId: ProjectId.make(form.projectId) },
              provider: {
                environmentId,
                instanceId: ProviderInstanceId.make(form.providerInstanceId),
              },
              model: form.model.trim(),
              title: form.threadTitle.trim(),
              prompt: form.prompt.trim(),
              runtimeMode: previousAgentAction?.runtimeMode ?? "approval-required",
              interactionMode:
                previousAgentAction?.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
            },
      schedule:
        form.scheduleKind === "interval"
          ? {
              kind: "interval",
              everyMinutes,
              anchorAt:
                previousInterval?.everyMinutes === everyMinutes ? previousInterval.anchorAt : now,
            }
          : {
              kind: "weekly",
              daysOfWeek: [...form.daysOfWeek].sort((left, right) => left - right),
              localTime: form.localTime,
              timezone: form.timezone.trim(),
            },
      enabled: form.enabled,
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{form.activity ? "Edit activity" : "Schedule activity"}</DialogTitle>
          <DialogDescription>
            {form.actionKind === "agentTurn"
              ? "Start agent work in an assigned Project while preserving context boundaries."
              : "Refresh selected MCP data in the background while preserving context boundaries."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-5">
          <div className="grid gap-1.5">
            <Label htmlFor="scheduled-activity-name">Name</Label>
            <Input
              id="scheduled-activity-name"
              value={form.name}
              maxLength={120}
              autoFocus
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="scheduled-activity-context">Context</Label>
            <Select
              value={form.contextId}
              disabled={form.activity !== null}
              onValueChange={(value) => {
                const context = catalog.contexts.find((candidate) => candidate.id === value);
                if (!context) return;
                setForm({
                  ...form,
                  contextId: context.id,
                  sourceIds: catalog.workHubSources
                    .filter(
                      (source) =>
                        source.enabled &&
                        source.contextId === context.id &&
                        source.provider.environmentId === environmentId,
                    )
                    .map((source) => source.id),
                  projectId:
                    catalog.projectBindings.find(
                      (binding) =>
                        binding.contextId === context.id &&
                        binding.project.environmentId === environmentId,
                    )?.project.projectId ?? "",
                  providerInstanceId:
                    resolveScheduledAgentTargets({
                      catalog,
                      contextId: context.id,
                      environmentId,
                    }).providers[0]?.instanceId ?? "",
                  model: "",
                });
              }}
            >
              <SelectTrigger id="scheduled-activity-context">
                <SelectValue>
                  {catalog.contexts.find((context) => context.id === form.contextId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {catalog.contexts.map((context) => (
                  <SelectItem key={context.id} value={context.id}>
                    {context.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="scheduled-activity-action">Action</Label>
            <Select
              value={form.actionKind}
              disabled={form.activity !== null}
              onValueChange={(value) =>
                (value === "workHubSync" || value === "agentTurn") &&
                setForm({
                  ...form,
                  actionKind: value,
                  name:
                    form.activity === null
                      ? value === "agentTurn"
                        ? "Scheduled agent"
                        : "Work Hub sync"
                      : form.name,
                })
              }
            >
              <SelectTrigger id="scheduled-activity-action">
                <SelectValue>
                  {form.actionKind === "agentTurn" ? "Start agent work" : "Sync Work Hub MCPs"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="workHubSync">Sync Work Hub MCPs</SelectItem>
                <SelectItem value="agentTurn">Start agent work</SelectItem>
              </SelectPopup>
            </Select>
          </div>
          {form.actionKind === "workHubSync" ? (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium text-foreground">MCP sources</legend>
              {sources.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/70 p-3 text-sm text-muted-foreground">
                  Select at least one MCP for this context in Work Hub sources first.
                </p>
              ) : (
                <div className="grid gap-2 rounded-xl border border-border/65 p-3 sm:grid-cols-2">
                  {sources.map((source) => (
                    <Label key={source.id} className="font-normal">
                      <Checkbox
                        checked={form.sourceIds.includes(source.id)}
                        onCheckedChange={(checked) =>
                          setForm({
                            ...form,
                            sourceIds: checked
                              ? [...form.sourceIds, source.id]
                              : form.sourceIds.filter((sourceId) => sourceId !== source.id),
                          })
                        }
                      />
                      <span className="truncate">{sourceLabel(catalog, source.id)}</span>
                    </Label>
                  ))}
                </div>
              )}
              {remoteSourceCount > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {remoteSourceCount} source{remoteSourceCount === 1 ? " is" : "s are"} hosted by
                  another environment and cannot be scheduled from this server yet. Manual sync
                  remains available.
                </p>
              ) : null}
            </fieldset>
          ) : (
            <div className="grid gap-4 rounded-xl border border-border/65 p-3">
              <div className="grid gap-1.5">
                <Label htmlFor="scheduled-agent-project">Project</Label>
                <Select
                  value={form.projectId}
                  onValueChange={(value) => {
                    if (value === null) return;
                    const project = boundProjects.find((candidate) => candidate.id === value);
                    const defaultModel =
                      project?.defaultModelSelection?.instanceId === form.providerInstanceId
                        ? project.defaultModelSelection.model
                        : "";
                    setForm({
                      ...form,
                      projectId: value,
                      model: form.model || defaultModel,
                    });
                  }}
                >
                  <SelectTrigger id="scheduled-agent-project">
                    <SelectValue placeholder="Project assigned to this context" />
                  </SelectTrigger>
                  <SelectPopup>
                    {boundProjects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {boundProjects.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Assign a Project to this context in Axis settings first.
                  </p>
                ) : null}
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="scheduled-agent-provider">Provider</Label>
                  <Select
                    value={form.providerInstanceId}
                    onValueChange={(value) => {
                      if (value === null) return;
                      const project = boundProjects.find(
                        (candidate) => candidate.id === form.projectId,
                      );
                      setForm({
                        ...form,
                        providerInstanceId: value,
                        model:
                          value === form.providerInstanceId
                            ? form.model
                            : project?.defaultModelSelection?.instanceId === value
                              ? project.defaultModelSelection.model
                              : "",
                      });
                    }}
                  >
                    <SelectTrigger id="scheduled-agent-provider">
                      <SelectValue placeholder="Provider" />
                    </SelectTrigger>
                    <SelectPopup>
                      {availableProviders.map((provider) => (
                        <SelectItem key={provider.instanceId} value={provider.instanceId}>
                          {provider.instanceId}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="scheduled-agent-model">Model</Label>
                  <Input
                    id="scheduled-agent-model"
                    value={form.model}
                    placeholder="Provider model ID"
                    onChange={(event) => setForm({ ...form, model: event.target.value })}
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="scheduled-agent-title">Thread title</Label>
                <Input
                  id="scheduled-agent-title"
                  value={form.threadTitle}
                  maxLength={120}
                  onChange={(event) => setForm({ ...form, threadTitle: event.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="scheduled-agent-prompt">Instructions</Label>
                <Textarea
                  id="scheduled-agent-prompt"
                  value={form.prompt}
                  rows={7}
                  maxLength={100_000}
                  placeholder="Describe the work the agent should start."
                  onChange={(event) => setForm({ ...form, prompt: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  The Thread starts in approval-required mode and stays inside this context.
                </p>
              </div>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="scheduled-activity-frequency">Frequency</Label>
            <Select
              value={form.scheduleKind}
              onValueChange={(value) =>
                (value === "interval" || value === "weekly") &&
                setForm({ ...form, scheduleKind: value })
              }
            >
              <SelectTrigger id="scheduled-activity-frequency">
                <SelectValue>
                  {form.scheduleKind === "interval" ? "Repeating interval" : "Weekly schedule"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="interval">Repeating interval</SelectItem>
                <SelectItem value="weekly">Weekly schedule</SelectItem>
              </SelectPopup>
            </Select>
          </div>
          {form.scheduleKind === "interval" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="scheduled-activity-hours">Run every (hours)</Label>
              <Input
                id="scheduled-activity-hours"
                type="number"
                min={1}
                step={1}
                value={form.everyHours}
                onChange={(event) => setForm({ ...form, everyHours: Number(event.target.value) })}
              />
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <fieldset className="grid gap-2 sm:col-span-2">
                <legend className="mb-1 text-sm font-medium text-foreground">Days</legend>
                <div className="flex flex-wrap gap-3">
                  {WEEKDAY_LABELS.map((label, day) => (
                    <Label key={label} className="font-normal">
                      <Checkbox
                        checked={form.daysOfWeek.includes(day)}
                        onCheckedChange={(checked) =>
                          setForm({
                            ...form,
                            daysOfWeek: checked
                              ? [...form.daysOfWeek, day]
                              : form.daysOfWeek.filter((candidate) => candidate !== day),
                          })
                        }
                      />
                      {label}
                    </Label>
                  ))}
                </div>
              </fieldset>
              <div className="grid gap-1.5">
                <Label htmlFor="scheduled-activity-time">Time</Label>
                <Input
                  id="scheduled-activity-time"
                  type="time"
                  value={form.localTime}
                  onChange={(event) => setForm({ ...form, localTime: event.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="scheduled-activity-timezone">Timezone</Label>
                <Input
                  id="scheduled-activity-timezone"
                  value={form.timezone}
                  placeholder="America/Fortaleza"
                  onChange={(event) => setForm({ ...form, timezone: event.target.value })}
                />
              </div>
            </div>
          )}
          <Label className="justify-between rounded-xl border border-border/65 p-3">
            <span>
              <span className="block">Enabled</span>
              <span className="mt-1 block text-xs font-normal text-muted-foreground">
                Disabled activities keep their history and can be resumed later.
              </span>
            </span>
            <Switch
              checked={form.enabled}
              onCheckedChange={(enabled) => setForm({ ...form, enabled })}
            />
          </Label>
          {validationError ? (
            <p role="alert" className="text-sm text-destructive">
              {validationError}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || validationError !== null}>
            {saving ? "Saving…" : form.activity ? "Save changes" : "Create activity"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function WorkHubScheduledActivities({
  catalog,
  environmentId,
  onWorkHubCacheChanged,
}: {
  readonly catalog: AxisContextCatalog;
  readonly environmentId: EnvironmentId;
  readonly onWorkHubCacheChanged: () => void;
}) {
  const activitiesQuery = useEnvironmentQuery(
    serverEnvironment.axisScheduledActivities({ environmentId, input: {} }),
  );
  const createActivity = useAtomCommand(serverEnvironment.createAxisScheduledActivity, {
    reportFailure: false,
  });
  const updateActivity = useAtomCommand(serverEnvironment.updateAxisScheduledActivity, {
    reportFailure: false,
  });
  const runNow = useAtomCommand(serverEnvironment.runAxisScheduledActivityNow, {
    reportFailure: false,
  });
  const deleteActivity = useAtomCommand(serverEnvironment.deleteAxisScheduledActivity, {
    reportFailure: false,
  });
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [historyActivity, setHistoryActivity] = useState<AxisScheduledActivity | null>(null);
  const [deletingActivity, setDeletingActivity] = useState<AxisScheduledActivity | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const activities = useMemo(
    () =>
      [...(activitiesQuery.data ?? [])].sort((left, right) =>
        left.nextRunAt.localeCompare(right.nextRunAt),
      ),
    [activitiesQuery.data],
  );

  const reportFailure = (title: string, result: { readonly _tag: string }) => {
    const error = squashAtomCommandFailure(result as never);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The request failed.",
    });
  };
  const save = async (draft: AxisScheduledActivityDraft) => {
    setPendingId(draft.id);
    const command = editor?.activity ? updateActivity : createActivity;
    const result = await command({ environmentId, input: { activity: draft } });
    setPendingId(null);
    if (result._tag !== "Success") {
      reportFailure("Could not save activity", result);
      return;
    }
    setEditor(null);
    activitiesQuery.refresh();
    toastManager.add({ type: "success", title: "Scheduled activity saved" });
  };
  const toggle = async (activity: AxisScheduledActivity) => {
    setPendingId(activity.id);
    const result = await updateActivity({
      environmentId,
      input: { activity: { ...activityDraft(activity), enabled: !activity.enabled } },
    });
    setPendingId(null);
    if (result._tag !== "Success") {
      reportFailure(`Could not ${activity.enabled ? "pause" : "resume"} activity`, result);
      return;
    }
    activitiesQuery.refresh();
  };
  const run = async (activity: AxisScheduledActivity) => {
    setPendingId(activity.id);
    const result = await runNow({ environmentId, input: { id: activity.id } });
    setPendingId(null);
    if (result._tag !== "Success") {
      reportFailure("Could not run activity", result);
      return;
    }
    activitiesQuery.refresh();
    if (activity.action.kind === "workHubSync") onWorkHubCacheChanged();
    toastManager.add({
      type: result.value.status === "failed" ? "error" : "success",
      title:
        result.value.status === "failed"
          ? "Activity failed"
          : activity.action.kind === "agentTurn"
            ? "Agent Thread started"
            : "Activity finished",
      description: result.value.message ?? undefined,
    });
  };
  const remove = async (activity: AxisScheduledActivity) => {
    setPendingId(activity.id);
    const result = await deleteActivity({ environmentId, input: { id: activity.id } });
    setPendingId(null);
    if (result._tag !== "Success") {
      reportFailure("Could not delete activity", result);
      return;
    }
    setDeletingActivity(null);
    activitiesQuery.refresh();
    toastManager.add({ type: "success", title: "Scheduled activity deleted" });
  };
  const beginCreate = () => {
    const state = activityEditorState(catalog, environmentId, null);
    if (!state) {
      toastManager.add({
        type: "info",
        title: "No schedulable targets available",
        description: "Select a Work Hub MCP source or assign a Project to an Axis context first.",
      });
      return;
    }
    setEditor(state);
  };

  return (
    <section className="rounded-2xl border border-border/70 bg-card/35 p-5 shadow-sm/5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium text-foreground">Scheduled activities</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Refresh MCP sources or start context-scoped agent work on a schedule.
          </p>
        </div>
        <Button size="sm" onClick={beginCreate}>
          <PlusIcon /> Schedule activity
        </Button>
      </div>
      {!activitiesQuery.data ? (
        <div className="flex min-h-40 items-center justify-center gap-2 rounded-xl border border-dashed border-border/75 text-sm text-muted-foreground">
          {activitiesQuery.error ? <CircleAlertIcon className="size-4" /> : null}
          {activitiesQuery.error ? "Could not load scheduled activities." : "Loading activities…"}
        </div>
      ) : activities.length === 0 ? (
        <div className="flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border/75 px-5 text-center">
          <CalendarClockIcon className="mb-2 size-6 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No scheduled activities</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Schedule MCP synchronization or agent work for an interval or specific weekdays.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {activities.map((activity) => {
            const context = catalog.contexts.find(
              (candidate) => candidate.id === activity.contextId,
            );
            const busy = pendingId === activity.id;
            return (
              <article
                key={activity.id}
                className="rounded-xl border border-border/65 bg-background/45 p-4"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-medium text-foreground">
                        {activity.name}
                      </h3>
                      <Badge variant={activity.enabled ? "secondary" : "outline"}>
                        {activity.enabled ? "Active" : "Paused"}
                      </Badge>
                      {activity.lastRunStatus ? (
                        <Badge variant={statusVariant(activity.lastRunStatus)}>
                          {activity.lastRunStatus}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {context?.name ?? activity.contextId} ·{" "}
                      {formatScheduledActivitySchedule(activity.schedule)}
                    </p>
                  </div>
                  <Switch
                    checked={activity.enabled}
                    disabled={busy}
                    aria-label={`${activity.enabled ? "Pause" : "Resume"} ${activity.name}`}
                    onCheckedChange={() => void toggle(activity)}
                  />
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {activity.action.kind === "workHubSync" ? (
                    activity.action.sourceIds.map((sourceId) => (
                      <Badge key={sourceId} variant="outline">
                        {sourceLabel(catalog, sourceId)}
                      </Badge>
                    ))
                  ) : (
                    <>
                      <Badge variant="outline">Agent Thread</Badge>
                      <Badge variant="outline">{activity.action.project.projectId}</Badge>
                      <Badge variant="outline">{activity.action.provider.instanceId}</Badge>
                    </>
                  )}
                </div>
                <div className="mt-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                  <p>Next: {activity.enabled ? formatTimestamp(activity.nextRunAt) : "Paused"}</p>
                  <p>Last: {formatTimestamp(activity.lastRunAt)}</p>
                </div>
                {activity.lastRunMessage ? (
                  <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                    {activity.lastRunMessage}
                  </p>
                ) : null}
                <div className="mt-4 flex flex-wrap justify-end gap-1.5">
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() => setHistoryActivity(activity)}
                  >
                    <HistoryIcon /> History
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() => setEditor(activityEditorState(catalog, environmentId, activity))}
                  >
                    <PencilIcon /> Edit
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Delete ${activity.name}`}
                    onClick={() => setDeletingActivity(activity)}
                  >
                    <Trash2Icon />
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(activity)}
                  >
                    {busy ? <RefreshCwIcon className="animate-spin" /> : <PlayIcon />}
                    {busy ? "Running…" : "Run now"}
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={busy}
                    aria-label={`${activity.enabled ? "Pause" : "Resume"} ${activity.name}`}
                    onClick={() => void toggle(activity)}
                  >
                    {activity.enabled ? <PauseIcon /> : <PlayIcon />}
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {editor ? (
        <ScheduledActivityEditor
          catalog={catalog}
          environmentId={environmentId}
          initial={editor}
          saving={pendingId !== null}
          onSave={(draft) => void save(draft)}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {historyActivity ? (
        <ScheduledActivityRunsDialog
          activity={historyActivity}
          environmentId={environmentId}
          onClose={() => setHistoryActivity(null)}
        />
      ) : null}
      {deletingActivity ? (
        <AlertDialog open onOpenChange={(open) => !open && setDeletingActivity(null)}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete scheduled activity?</AlertDialogTitle>
              <AlertDialogDescription>
                {deletingActivity.name} and its run history will be permanently removed.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
              <Button
                variant="destructive"
                disabled={pendingId === deletingActivity.id}
                onClick={() => void remove(deletingActivity)}
              >
                {pendingId === deletingActivity.id ? "Deleting…" : "Delete activity"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      ) : null}
    </section>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertCircleIcon,
  BanIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  XCircleIcon,
} from "lucide-react";
import {
  CommandId,
  type AxisContextProjectScope,
  type AxisTaskExtension,
  type AxisWorkflowSnapshot,
  type AxisTaskStep,
  type EnvironmentConnectionState,
  type EnvironmentId,
  type ModelSelection,
  ThreadId,
  AxisTaskId,
} from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { randomUUID } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  buildNewProjectTask,
  canRecordTaskFeedback,
  canStartProjectWorkflow,
  filterProjectThreadTasks,
  isSupportedAxisWorkflowSkill,
  preferObservedWorkflowTask,
  workflowStatusLabel,
  workflowStepStatusLabel,
} from "./projectWorkflowModel";

type WorkflowConnectionState = EnvironmentConnectionState | "unauthorized";
type Action = "start" | "retry" | "cancel" | "create" | "feedback" | null;

const skillLabel = (skillId: string) => skillId.charAt(0).toUpperCase() + skillId.slice(1);
const checkWorkflowAdmission = (snapshot: AxisWorkflowSnapshot) => {
  if (snapshot.state.status === "blocked") {
    throw new Error(snapshot.state.reason ?? "This workflow step cannot start yet.");
  }
};
const iconForStatus = (status: string) =>
  status === "completed"
    ? CheckCircle2Icon
    : status === "failed" || status === "blocked"
      ? AlertCircleIcon
      : status === "interrupted"
        ? XCircleIcon
        : status === "running" || status === "accepted"
          ? LoaderCircleIcon
          : CircleDashedIcon;

export function ProjectWorkflowPanel({
  environmentId,
  scope,
  threadId,
  modelSelection,
  connectionState,
  projectLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: AxisContextProjectScope;
  readonly threadId: ThreadId | null;
  readonly modelSelection: ModelSelection | null;
  readonly connectionState: WorkflowConnectionState;
  readonly projectLabel?: string;
}) {
  const [selectedTaskId, setSelectedTaskId] = useState<AxisTaskExtension["id"] | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<AxisTaskStep["id"] | null>(null);
  const [title, setTitle] = useState("");
  const [action, setAction] = useState<Action>(null);
  const [error, setError] = useState<string | null>(null);
  const [recordedFeedback, setRecordedFeedback] = useState<{
    readonly commandId: string;
    readonly evidenceId: string;
  } | null>(null);
  const connected =
    connectionState === "connected" && scope.project.environmentId === environmentId;
  const tasksQuery = useEnvironmentQuery(
    connected ? serverEnvironment.axisTasks({ environmentId, input: { scope } }) : null,
  );
  const tasks = useMemo(
    () => filterProjectThreadTasks(tasksQuery.data ?? [], scope, threadId),
    [scope, tasksQuery.data, threadId],
  );
  const listedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null;
  const listedStep =
    listedTask?.steps.find((step) => step.id === selectedStepId) ?? listedTask?.steps[0] ?? null;
  const attemptQuery = useEnvironmentQuery(
    connected &&
      listedTask !== null &&
      listedStep?.commandId !== null &&
      listedStep?.commandId !== undefined &&
      threadId !== null
      ? serverEnvironment.axisWorkflowAttempt({
          environmentId,
          input: {
            scope,
            threadId,
            taskId: listedTask.id,
            stepId: listedStep.id,
            commandId: listedStep.commandId,
          },
        })
      : null,
  );
  // axis.workflow.get may settle task metadata after a restart. Its returned
  // task is newer than the independently refreshed task list for this attempt.
  const selectedTask = preferObservedWorkflowTask(listedTask, attemptQuery.data?.task ?? null);
  const selectedStep =
    selectedTask?.steps.find((step) => step.id === selectedStepId) ??
    selectedTask?.steps.find((step) => step.id === listedStep?.id) ??
    selectedTask?.steps[0] ??
    null;
  const createTask = useAtomCommand(serverEnvironment.createAxisTask, { reportFailure: false });
  const startWorkflow = useAtomCommand(serverEnvironment.startAxisWorkflow, {
    reportFailure: false,
  });
  const retryWorkflow = useAtomCommand(serverEnvironment.retryAxisWorkflow, {
    reportFailure: false,
  });
  const cancelWorkflow = useAtomCommand(serverEnvironment.cancelAxisWorkflow, {
    reportFailure: false,
  });
  const recordTaskFeedback = useAtomCommand(serverEnvironment.recordAxisTaskFeedback, {
    reportFailure: false,
  });
  const currentState = attemptQuery.data?.state ?? null;
  const attemptRevision = attemptQuery.data?.task.revision ?? selectedTask?.revision;
  const attemptCommandId = currentState?.execution.commandId ?? selectedStep?.commandId ?? null;
  const attemptUnavailable =
    selectedStep?.commandId !== null &&
    selectedStep?.commandId !== undefined &&
    (attemptQuery.isPending || attemptQuery.error !== null);

  const run = async <A, E>(
    next: Exclude<Action, null>,
    command: () => Promise<AtomCommandResult<A, E>>,
    onSuccess?: (value: A) => void,
  ): Promise<boolean> => {
    if (action !== null) return false;
    setAction(next);
    setError(null);
    try {
      const result = await command();
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      onSuccess?.(result.value);
      tasksQuery.refresh();
      attemptQuery.refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The workflow operation failed.");
      return false;
    } finally {
      setAction(null);
    }
  };
  const create = () => {
    if (!connected || threadId === null || title.trim() === "") return;
    const now = new Date().toISOString();
    const task = buildNewProjectTask({
      id: AxisTaskId.make(`axis-task-${randomUUID()}`),
      scope,
      threadId,
      title: title.trim(),
      createdAt: now,
    });
    void run("create", () =>
      createTask({
        environmentId,
        input: { task, commandId: CommandId.make(`axis-task-${randomUUID()}`) },
      }),
    ).then((succeeded) => {
      if (succeeded) setTitle("");
    });
  };

  useEffect(() => {
    if (
      !connected ||
      attemptQuery.error !== null ||
      !["accepted", "running", "waiting-input"].includes(currentState?.status ?? "")
    )
      return;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      tasksQuery.refresh();
      attemptQuery.refresh();
    };
    const timer = window.setInterval(refresh, 2_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [
    connected,
    attemptQuery.error,
    attemptQuery.refresh,
    currentState?.status,
    tasksQuery.refresh,
  ]);

  if (scope.project.environmentId !== environmentId)
    return (
      <SettingsSection title="Workflow">
        <SettingsRow
          title="Project environment mismatch"
          description="The selected physical project belongs to another environment."
        />
      </SettingsSection>
    );
  if (connectionState !== "connected")
    return (
      <SettingsSection title="Workflow">
        <SettingsRow
          title="Environment disconnected"
          description="Connect this environment to inspect and run project workflows."
        />
      </SettingsSection>
    );
  if (threadId === null)
    return (
      <SettingsSection title="Workflow">
        <SettingsRow
          title="No project thread selected"
          description="A canonical project thread is required before tasks or workflow attempts can be shown."
        />
      </SettingsSection>
    );
  if (tasksQuery.isPending && tasksQuery.data === null)
    return (
      <SettingsSection title="Workflow">
        <SettingsRow title="Loading tasks" />
      </SettingsSection>
    );
  if (tasksQuery.error !== null)
    return (
      <SettingsSection title="Workflow">
        <SettingsRow
          title="Could not load tasks"
          description={tasksQuery.error}
          control={
            <Button size="xs" variant="outline" onClick={tasksQuery.refresh}>
              <RefreshCwIcon />
              Refresh
            </Button>
          }
        />
      </SettingsSection>
    );

  const canStart = canStartProjectWorkflow({
    connectionState,
    threadId,
    task: selectedTask,
    step: selectedStep,
    modelSelection,
  });
  const canCancel =
    currentState !== null &&
    ["accepted", "running", "waiting-input"].includes(currentState.status) &&
    selectedTask !== null &&
    attemptCommandId !== null;
  const canRetry =
    currentState !== null &&
    ["failed", "interrupted"].includes(currentState.status) &&
    selectedTask !== null &&
    attemptCommandId !== null &&
    modelSelection !== null;
  const feedbackRecordedForAttempt =
    attemptCommandId !== null && recordedFeedback?.commandId === attemptCommandId;
  const canRecordFeedback =
    !feedbackRecordedForAttempt &&
    canRecordTaskFeedback({
      connectionState,
      threadId,
      task: selectedTask,
      step: selectedStep,
      state: currentState,
    });
  return (
    <SettingsSection
      title="Workflow"
      description={`${projectLabel === undefined ? "" : `Physical project: ${projectLabel}. `}Intake, impact and plan produce reviewable documents. Implementation, verification, self-review and PR publication are not available here yet.`}
      headerAction={
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            tasksQuery.refresh();
            attemptQuery.refresh();
          }}
          disabled={action !== null}
        >
          <RefreshCwIcon />
          Refresh
        </Button>
      }
    >
      {tasks.length === 0 ? (
        <div className="flex flex-wrap items-end gap-2 border-b border-border/50 px-4 py-3">
          <Input
            className="min-w-48 flex-1"
            value={title}
            placeholder="New task title"
            aria-label="New task title"
            disabled={action !== null}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Button size="xs" disabled={action !== null || title.trim() === ""} onClick={create}>
            Create task
          </Button>
        </div>
      ) : null}
      {error !== null ? (
        <div className="flex items-center gap-2 px-4 py-3 text-sm text-destructive">
          <AlertCircleIcon />
          {error}
        </div>
      ) : null}
      {tasks.length === 0 ? (
        <SettingsRow
          title="No tasks for this project thread"
          description="Create a task to begin the supported workflow."
        />
      ) : (
        <>
          {tasks.map((task) => (
            <div key={task.id} className="border-b border-border/50 px-4 py-3">
              <button
                type="button"
                className="flex w-full items-center justify-between text-left"
                onClick={() => {
                  setSelectedTaskId(task.id);
                  setSelectedStepId(task.steps[0]?.id ?? null);
                }}
              >
                <span className="font-medium">{task.title}</span>
                <Badge variant={task.status === "active" ? "success" : "secondary"}>
                  {task.status}
                </Badge>
              </button>
              {(selectedTask?.id === task.id ? task.steps : []).map((step) => {
                const status =
                  step.id === selectedStep?.id
                    ? (currentState?.status ?? "not-executed")
                    : step.status;
                const Icon = iconForStatus(status);
                const supported = isSupportedAxisWorkflowSkill(step.skillId);
                return (
                  <div key={step.id} className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      size="xs"
                      variant={step.id === selectedStep?.id ? "secondary" : "ghost"}
                      onClick={() => setSelectedStepId(step.id)}
                    >
                      <Icon />
                      <span>{skillLabel(step.skillId)}</span>
                    </Button>
                    <Badge variant={supported ? "outline" : "warning"}>
                      {supported
                        ? step.id === selectedStep?.id
                          ? attemptUnavailable
                            ? attemptQuery.error !== null
                              ? "Status unavailable"
                              : "Loading status"
                            : workflowStatusLabel(currentState)
                          : workflowStepStatusLabel(step)
                        : "Unavailable"}
                    </Badge>
                    {step.id === selectedStep?.id ? (
                      <div className="ml-auto flex gap-1">
                        {canStart ? (
                          <Button
                            size="xs"
                            disabled={action !== null || attemptQuery.isPending}
                            onClick={() =>
                              void run(
                                "start",
                                async () =>
                                  startWorkflow({
                                    environmentId,
                                    input: {
                                      scope,
                                      threadId,
                                      taskId: task.id,
                                      stepId: step.id,
                                      commandId: CommandId.make(`axis-workflow-${randomUUID()}`),
                                      expectedRevision: attemptRevision!,
                                      modelSelection: modelSelection!,
                                    },
                                  }),
                                checkWorkflowAdmission,
                              )
                            }
                          >
                            Start
                          </Button>
                        ) : canRetry ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={action !== null}
                            onClick={() =>
                              void run(
                                "retry",
                                async () =>
                                  retryWorkflow({
                                    environmentId,
                                    input: {
                                      scope,
                                      threadId,
                                      taskId: task.id,
                                      stepId: step.id,
                                      commandId: CommandId.make(`axis-workflow-${randomUUID()}`),
                                      previousCommandId: attemptCommandId!,
                                      expectedRevision: attemptRevision!,
                                      modelSelection: modelSelection!,
                                    },
                                  }),
                                checkWorkflowAdmission,
                              )
                            }
                          >
                            Retry
                          </Button>
                        ) : canCancel ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={action !== null}
                            onClick={() =>
                              void run("cancel", async () =>
                                cancelWorkflow({
                                  environmentId,
                                  input: {
                                    scope,
                                    threadId,
                                    taskId: task.id,
                                    stepId: step.id,
                                    commandId: attemptCommandId!,
                                    expectedRevision: attemptRevision!,
                                  },
                                }),
                              )
                            }
                          >
                            Cancel
                          </Button>
                        ) : null}
                        {canRecordFeedback ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={action !== null}
                            onClick={() =>
                              void run(
                                "feedback",
                                async () =>
                                  recordTaskFeedback({
                                    environmentId,
                                    input: {
                                      scope,
                                      threadId: threadId!,
                                      taskId: task.id,
                                      stepId: step.id,
                                      commandId: attemptCommandId!,
                                      expectedTurnId: currentState!.execution.turnId!,
                                    },
                                  }),
                                (evidence) =>
                                  setRecordedFeedback({
                                    commandId: attemptCommandId!,
                                    evidenceId: evidence.id,
                                  }),
                              )
                            }
                          >
                            <CheckCircle2Icon />
                            Record outcome
                          </Button>
                        ) : null}
                        {feedbackRecordedForAttempt ? (
                          <Badge
                            variant="success"
                            title={`Evidence ${recordedFeedback!.evidenceId}`}
                          >
                            Outcome recorded
                          </Badge>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </>
      )}
      {selectedStep?.skillId !== undefined &&
      !isSupportedAxisWorkflowSkill(selectedStep.skillId) ? (
        <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
          <BanIcon />
          This workflow step is not available yet.
        </div>
      ) : null}
      {modelSelection === null ? (
        <div className="px-4 py-3 text-xs text-muted-foreground">
          No provider/model selection is available for workflow execution.
        </div>
      ) : null}
      {attemptQuery.error !== null ? (
        <div className="px-4 py-3 text-xs text-destructive">{attemptQuery.error}</div>
      ) : null}
      {currentState?.status === "waiting-input" ? (
        <SettingsRow
          title="Workflow is waiting for input"
          description="Open the execution thread to respond to the provider request."
          control={
            <Button
              size="xs"
              variant="outline"
              render={
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: currentState.execution.threadId }}
                />
              }
            >
              Open execution thread
            </Button>
          }
        />
      ) : null}
      {attemptQuery.data?.state.artifact !== null &&
      attemptQuery.data?.state.artifact !== undefined ? (
        <article className="space-y-2 border-t border-border/50 px-4 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="info">Document artifact</Badge>
            <span className="text-xs text-muted-foreground">
              {attemptQuery.data.state.artifact.skillId}
            </span>
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border/50 bg-muted/30 p-3 text-xs leading-5 text-foreground">
            {attemptQuery.data.state.artifact.text}
          </pre>
        </article>
      ) : null}
    </SettingsSection>
  );
}

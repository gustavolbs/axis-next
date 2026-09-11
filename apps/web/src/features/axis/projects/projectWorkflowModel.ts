import type {
  AxisContextProjectScope,
  AxisTaskExtension,
  AxisTaskStep,
  AxisWorkflowState,
  ModelSelection,
} from "@t3tools/contracts";

export const SUPPORTED_AXIS_WORKFLOW_SKILLS = ["intake", "impact", "plan"] as const;
export type SupportedAxisWorkflowSkill = (typeof SUPPORTED_AXIS_WORKFLOW_SKILLS)[number];

export function isSupportedAxisWorkflowSkill(
  skillId: string,
): skillId is SupportedAxisWorkflowSkill {
  return (SUPPORTED_AXIS_WORKFLOW_SKILLS as ReadonlyArray<string>).includes(skillId);
}

export function samePhysicalProjectScope(
  left: AxisContextProjectScope,
  right: AxisContextProjectScope,
): boolean {
  return (
    left.contextId === right.contextId &&
    left.project.environmentId === right.project.environmentId &&
    left.project.projectId === right.project.projectId
  );
}

export function filterProjectThreadTasks(
  tasks: ReadonlyArray<AxisTaskExtension>,
  scope: AxisContextProjectScope,
  threadId: AxisTaskExtension["threadId"] | null,
): ReadonlyArray<AxisTaskExtension> {
  if (threadId === null) return [];
  return tasks.filter(
    (task) => samePhysicalProjectScope(task.scope, scope) && task.threadId === threadId,
  );
}

export function preferObservedWorkflowTask(
  listed: AxisTaskExtension | null,
  observed: AxisTaskExtension | null,
): AxisTaskExtension | null {
  if (
    listed === null ||
    observed === null ||
    observed.id !== listed.id ||
    observed.threadId !== listed.threadId ||
    !samePhysicalProjectScope(observed.scope, listed.scope) ||
    observed.revision < listed.revision
  )
    return listed;
  return observed;
}

export function canStartProjectWorkflow(input: {
  readonly connectionState: string;
  readonly threadId: AxisTaskExtension["threadId"] | null;
  readonly task: AxisTaskExtension | null;
  readonly step: AxisTaskStep | null;
  readonly modelSelection: ModelSelection | null;
}): boolean {
  return (
    input.connectionState === "connected" &&
    input.threadId !== null &&
    input.task !== null &&
    input.step !== null &&
    input.task.threadId === input.threadId &&
    input.task.status === "active" &&
    input.task.steps.some((candidate) => candidate.id === input.step?.id) &&
    input.task.steps
      .slice(
        0,
        input.task.steps.findIndex((step) => step.id === input.step?.id),
      )
      .every(
        (step) =>
          step.status === "completed" ||
          (step.status === "not-applicable" && (step.reason?.trim().length ?? 0) > 0),
      ) &&
    input.step.status === "not-executed" &&
    input.step.turnId === null &&
    input.step.commandId === null &&
    isSupportedAxisWorkflowSkill(input.step.skillId) &&
    input.modelSelection !== null
  );
}

export function workflowStatusLabel(state: AxisWorkflowState | null): string {
  if (state === null) return "Not executed";
  return state.status
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function workflowStepStatusLabel(step: AxisTaskStep): string {
  return step.status
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function buildNewProjectTask(input: {
  readonly id: AxisTaskExtension["id"];
  readonly scope: AxisContextProjectScope;
  readonly threadId: AxisTaskExtension["threadId"];
  readonly title: string;
  readonly createdAt: string;
}): AxisTaskExtension {
  return {
    id: input.id,
    scope: input.scope,
    threadId: input.threadId,
    title: input.title,
    acceptanceCriteria: [],
    workflowVersion: "axis-default-1",
    steps: SUPPORTED_AXIS_WORKFLOW_SKILLS.map((skillId) => ({
      id: `${input.id}-${skillId}` as AxisTaskStep["id"],
      skillId: skillId as AxisTaskStep["skillId"],
      status: "not-executed",
      turnId: null,
      commandId: null,
      reason: null,
      startedAt: null,
      finishedAt: null,
    })),
    status: "active",
    revision: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

import { describe, expect, it } from "vite-plus/test";
import {
  AxisContextId,
  AxisTaskId,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type { AxisContextProjectScope, AxisTaskExtension } from "@t3tools/contracts";
import {
  buildNewProjectTask,
  canRecordTaskFeedback,
  canStartProjectWorkflow,
  filterProjectThreadTasks,
  isSupportedAxisWorkflowSkill,
  preferObservedWorkflowTask,
  workflowStepStatusLabel,
} from "./projectWorkflowModel";

const scope = {
  contextId: AxisContextId.make("company"),
  project: { environmentId: EnvironmentId.make("env"), projectId: ProjectId.make("project") },
} satisfies AxisContextProjectScope;
const threadId = ThreadId.make("thread");

const task = (overrides: Partial<AxisTaskExtension> = {}): AxisTaskExtension =>
  buildNewProjectTask({
    id: AxisTaskId.make("task"),
    scope,
    threadId,
    title: "Implement workflow",
    createdAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  });

describe("project workflow model", () => {
  it("keeps only tasks from the selected physical project thread", () => {
    const otherThread = ThreadId.make("other-thread");
    const otherScope = {
      ...scope,
      project: { ...scope.project, projectId: ProjectId.make("other") },
    };
    expect(
      filterProjectThreadTasks(
        [task(), task({ threadId: otherThread }), task({ scope: otherScope })],
        scope,
        threadId,
      ),
    ).toHaveLength(1);
    expect(filterProjectThreadTasks([task()], scope, null)).toEqual([]);
  });

  it("allows only the currently supported intake, impact and plan skills", () => {
    expect(isSupportedAxisWorkflowSkill("intake")).toBe(true);
    expect(isSupportedAxisWorkflowSkill("impact")).toBe(true);
    expect(isSupportedAxisWorkflowSkill("plan")).toBe(true);
    expect(isSupportedAxisWorkflowSkill("execute")).toBe(false);
  });

  it("uses settlement returned by workflow get without adopting another task or stale revision", () => {
    const listed = task();
    const settled = {
      ...listed,
      revision: 1,
      steps: [{ ...listed.steps[0]!, status: "completed" as const }, ...listed.steps.slice(1)],
    };
    expect(preferObservedWorkflowTask(listed, settled)).toEqual(settled);
    expect(preferObservedWorkflowTask(settled, listed)).toEqual(settled);
    expect(
      preferObservedWorkflowTask(listed, {
        ...settled,
        threadId: ThreadId.make("another-thread"),
      }),
    ).toEqual(listed);
  });

  it("requires the authoritative thread, model and an unstarted supported step", () => {
    const selected = task();
    const step = selected.steps[0]!;
    const modelSelection = { instanceId: ProviderInstanceId.make("provider"), model: "model" };
    expect(
      canStartProjectWorkflow({
        connectionState: "connected",
        threadId,
        task: selected,
        step,
        modelSelection,
      }),
    ).toBe(true);
    expect(
      canStartProjectWorkflow({
        connectionState: "connected",
        threadId: null,
        task: selected,
        step,
        modelSelection,
      }),
    ).toBe(false);
    expect(
      canStartProjectWorkflow({
        connectionState: "disconnected",
        threadId,
        task: selected,
        step,
        modelSelection,
      }),
    ).toBe(false);
  });

  it("records feedback only for the selected canonical terminal attempt", () => {
    const selected = task();
    const step = {
      ...selected.steps[0]!,
      commandId: CommandId.make("attempt"),
      turnId: TurnId.make("turn"),
      status: "completed" as const,
    };
    const state = {
      taskId: selected.id,
      stepId: step.id,
      status: "completed" as const,
      execution: {
        threadId: ThreadId.make("axis-execution"),
        turnId: TurnId.make("turn"),
        commandId: CommandId.make("attempt"),
      },
      artifact: null,
      reason: null,
    };
    expect(
      canRecordTaskFeedback({
        connectionState: "connected",
        threadId,
        task: selected,
        step,
        state,
      }),
    ).toBe(true);
    expect(
      canRecordTaskFeedback({
        connectionState: "connected",
        threadId,
        task: selected,
        step,
        state: { ...state, status: "running" },
      }),
    ).toBe(false);
    expect(
      canRecordTaskFeedback({
        connectionState: "connected",
        threadId,
        task: selected,
        step: { ...step, turnId: TurnId.make("other-turn") },
        state,
      }),
    ).toBe(false);
    expect(
      canRecordTaskFeedback({
        connectionState: "connected",
        threadId,
        task: selected,
        step,
        state: {
          ...state,
          execution: { ...state.execution, commandId: CommandId.make("other-attempt") },
        },
      }),
    ).toBe(false);
    expect(
      canRecordTaskFeedback({
        connectionState: "disconnected",
        threadId,
        task: selected,
        step,
        state,
      }),
    ).toBe(false);
  });

  it("shows persisted status for steps that are not selected", () => {
    const selected = task();
    expect(workflowStepStatusLabel({ ...selected.steps[0]!, status: "completed" })).toBe(
      "Completed",
    );
    expect(workflowStepStatusLabel({ ...selected.steps[1]!, status: "not-applicable" })).toBe(
      "Not Applicable",
    );
  });
});

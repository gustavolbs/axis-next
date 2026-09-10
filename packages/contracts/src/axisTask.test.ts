import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AxisOnboardingTask,
  AxisSkillDefinition,
  AxisTaskExecution,
  AxisTaskExtension,
  AxisTaskPurpose,
  AxisTaskSource,
  AxisTaskStep,
} from "./axisTask.ts";

const decodeTask = Schema.decodeUnknownSync(AxisTaskExtension);
const decodeExecutionTask = Schema.decodeUnknownSync(AxisTaskExecution);
const decodeOnboardingTask = Schema.decodeUnknownSync(AxisOnboardingTask);
const decodePurpose = Schema.decodeUnknownSync(AxisTaskPurpose);
const decodeSource = Schema.decodeUnknownSync(AxisTaskSource);
const decodeStep = Schema.decodeUnknownSync(AxisTaskStep);
const decodeSkill = Schema.decodeUnknownSync(AxisSkillDefinition);

const scope = {
  contextId: "company_a",
  project: { environmentId: "laptop", projectId: "venue-sites" },
};

describe("Axis task contracts", () => {
  it("keeps legacy purpose omission while requiring onboarding purpose", () => {
    expect(decodePurpose("execution")).toBe("execution");
    expect(decodePurpose("onboarding")).toBe("onboarding");
    expect(() => decodePurpose("provider")).toThrow();

    const taskWithoutPurpose = decodeExecutionTask({
      id: "task-legacy-purpose",
      scope,
      threadId: "thread-legacy-purpose",
      title: "Prepare the project profile",
      acceptanceCriteria: [{ id: "criteria", text: "The profile is ready for review." }],
      workflowVersion: "axis-default-1",
      steps: [],
      revision: 0,
      createdAt: "2026-09-09T10:00:00.000Z",
      updatedAt: "2026-09-09T10:00:00.000Z",
    });
    expect(taskWithoutPurpose).not.toHaveProperty("purpose");

    const onboardingTask = decodeOnboardingTask({
      id: "task-purpose",
      scope,
      threadId: "thread-purpose",
      purpose: "onboarding",
      title: "Prepare the project profile",
      acceptanceCriteria: [{ id: "criteria", text: "The profile is ready for review." }],
      workflowVersion: "axis-default-1",
      steps: [],
      revision: 0,
      createdAt: "2026-09-09T10:00:00.000Z",
      updatedAt: "2026-09-09T10:00:00.000Z",
    });
    expect(onboardingTask.purpose).toBe("onboarding");
    expect(decodeTask(onboardingTask).purpose).toBe("onboarding");
    expect(() => decodeOnboardingTask({ ...onboardingTask, purpose: undefined })).toThrow();
    expect(() => decodeExecutionTask({ ...onboardingTask, purpose: "onboarding" })).toThrow();
  });

  it("allows a local task without tracker metadata", () => {
    expect(decodeSource({ kind: "local", label: "Fix the checkout tests" })).toEqual({
      kind: "local",
      label: "Fix the checkout tests",
    });
  });

  it("keeps task step outcomes distinct and links progress to T3 ids", () => {
    expect(
      decodeStep({
        id: "verify",
        skillId: "verify",
        status: "not-applicable",
        turnId: null,
        commandId: null,
        reason: "No UI changes in this task.",
        startedAt: null,
        finishedAt: null,
      }).status,
    ).toBe("not-applicable");
    expect(
      decodeStep({
        id: "implement",
        skillId: "implement",
        status: "completed",
        turnId: "turn-1",
        commandId: "command-1",
        reason: null,
        startedAt: "2026-09-09T10:00:00.000Z",
        finishedAt: "2026-09-09T10:05:00.000Z",
      }),
    ).toMatchObject({ turnId: "turn-1", commandId: "command-1" });
  });

  it("does not require a provider or session replica", () => {
    const skill = decodeSkill({
      id: "analyze",
      version: "1",
      name: "Analyze task",
      description: "Extract acceptance criteria.",
      inputs: [],
      outputs: [],
      requiredCapabilities: [],
    });
    const task = decodeTask({
      id: "task-1",
      scope,
      threadId: "thread-1",
      title: "Improve checkout tests",
      acceptanceCriteria: [{ id: "criteria", text: "The focused tests pass." }],
      workflowVersion: "axis-default-1",
      steps: [],
      revision: 0,
      createdAt: "2026-09-09T10:00:00.000Z",
      updatedAt: "2026-09-09T10:00:00.000Z",
    });
    expect(skill.requiredCapabilities).toEqual([]);
    expect(task).not.toHaveProperty("provider");
    expect(task).not.toHaveProperty("session");
  });
});

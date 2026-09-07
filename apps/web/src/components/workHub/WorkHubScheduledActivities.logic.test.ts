import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AxisContextCatalog, AxisContextId, EnvironmentId } from "@t3tools/contracts";

import {
  formatScheduledActivitySchedule,
  resolveScheduledAgentTargets,
  sourceSelectionBelongsToContext,
  validateScheduledActivityForm,
} from "./WorkHubScheduledActivities.logic";

const decodeCatalog = Schema.decodeUnknownSync(AxisContextCatalog);

describe("formatScheduledActivitySchedule", () => {
  it("uses readable units for intervals", () => {
    expect(
      formatScheduledActivitySchedule({
        kind: "interval",
        everyMinutes: 480,
        anchorAt: "2026-09-05T12:00:00.000Z",
      }),
    ).toBe("Every 8 hours");
    expect(
      formatScheduledActivitySchedule({
        kind: "interval",
        everyMinutes: 2_880,
        anchorAt: "2026-09-05T12:00:00.000Z",
      }),
    ).toBe("Every 2 days");
  });

  it("sorts and labels weekly schedules", () => {
    expect(
      formatScheduledActivitySchedule({
        kind: "weekly",
        daysOfWeek: [5, 1, 3],
        localTime: "09:30",
        timezone: "America/Fortaleza",
      }),
    ).toBe("Mon, Wed, Fri at 09:30 (America/Fortaleza)");
  });
});

describe("validateScheduledActivityForm", () => {
  const valid = {
    name: "Morning sync",
    actionKind: "workHubSync" as const,
    sourceIds: ["source_a"],
    projectId: "",
    providerInstanceId: "",
    model: "",
    threadTitle: "",
    prompt: "",
    availableProjectIds: [] as ReadonlyArray<string>,
    availableProviderInstanceIds: [] as ReadonlyArray<string>,
    scheduleKind: "interval" as const,
    everyHours: 8,
    daysOfWeek: [] as ReadonlyArray<number>,
    localTime: "09:00",
    timezone: "America/Fortaleza",
  };

  it("requires a name and at least one source", () => {
    expect(validateScheduledActivityForm({ ...valid, name: " " })).toBe(
      "Enter a name for this activity.",
    );
    expect(validateScheduledActivityForm({ ...valid, sourceIds: [] })).toBe(
      "Select at least one Work Hub source.",
    );
  });

  it("validates interval and weekly schedules", () => {
    expect(validateScheduledActivityForm({ ...valid, everyHours: 0 })).toBe(
      "Interval must be at least one whole hour.",
    );
    expect(
      validateScheduledActivityForm({ ...valid, scheduleKind: "weekly", daysOfWeek: [] }),
    ).toBe("Select at least one day of the week.");
    expect(
      validateScheduledActivityForm({
        ...valid,
        scheduleKind: "weekly",
        daysOfWeek: [1],
        localTime: "25:00",
      }),
    ).toBe("Enter a valid local time.");
  });

  it("requires every target needed to start scheduled agent work", () => {
    const agent = {
      ...valid,
      actionKind: "agentTurn" as const,
      sourceIds: [],
      projectId: "project_a",
      providerInstanceId: "codex",
      model: "gpt-5",
      threadTitle: "Morning briefing",
      prompt: "Prepare the briefing.",
      availableProjectIds: ["project_a"],
      availableProviderInstanceIds: ["codex"],
    };
    expect(validateScheduledActivityForm(agent)).toBe(null);
    expect(validateScheduledActivityForm({ ...agent, projectId: "" })).toBe(
      "Select a Project assigned to this context.",
    );
    expect(validateScheduledActivityForm({ ...agent, prompt: " " })).toBe(
      "Enter the instructions for the scheduled agent.",
    );
    expect(validateScheduledActivityForm({ ...agent, availableProjectIds: ["project_b"] })).toBe(
      "The selected Project is no longer assigned to this context.",
    );
    expect(
      validateScheduledActivityForm({
        ...agent,
        availableProviderInstanceIds: ["claude"],
      }),
    ).toBe("The selected provider is no longer available to this context.");
  });
});

describe("resolveScheduledAgentTargets", () => {
  it("keeps Projects and owned/granted providers inside context and environment boundaries", () => {
    const catalog = decodeCatalog({
      contexts: [
        {
          id: "personal",
          kind: "personal",
          name: "Personal",
          createdAt: "2026-09-06T00:00:00.000Z",
          updatedAt: "2026-09-06T00:00:00.000Z",
        },
        {
          id: "company_a",
          kind: "company",
          name: "Company A",
          createdAt: "2026-09-06T00:00:00.000Z",
          updatedAt: "2026-09-06T00:00:00.000Z",
        },
      ],
      projectBindings: [
        {
          contextId: "company_a",
          project: { environmentId: "local", projectId: "company_project" },
        },
        {
          contextId: "company_a",
          project: { environmentId: "remote", projectId: "remote_project" },
        },
        {
          contextId: "personal",
          project: { environmentId: "local", projectId: "personal_project" },
        },
      ],
      providerOwnerships: [
        {
          contextId: "personal",
          provider: { environmentId: "local", instanceId: "codex_personal" },
        },
        {
          contextId: "company_a",
          provider: { environmentId: "local", instanceId: "claude_company" },
        },
      ],
      providerAccessGrants: [
        {
          id: "grant_personal_codex",
          ownerContextId: "personal",
          targetContextId: "company_a",
          provider: { environmentId: "local", instanceId: "codex_personal" },
          status: "active",
          createdAt: "2026-09-06T00:00:00.000Z",
          updatedAt: "2026-09-06T00:00:00.000Z",
        },
      ],
    });

    const targets = resolveScheduledAgentTargets({
      catalog,
      contextId: AxisContextId.make("company_a"),
      environmentId: EnvironmentId.make("local"),
    });

    expect(targets.projects.map((project) => project.projectId)).toEqual(["company_project"]);
    expect(targets.providers.map((provider) => provider.instanceId)).toEqual([
      "claude_company",
      "codex_personal",
    ]);
  });
});

describe("sourceSelectionBelongsToContext", () => {
  it("only accepts non-empty selections fully owned by the context", () => {
    expect(sourceSelectionBelongsToContext(["a", "b"], ["a", "b", "c"])).toBe(true);
    expect(sourceSelectionBelongsToContext(["a", "elsewhere"], ["a", "b"])).toBe(false);
    expect(sourceSelectionBelongsToContext([], ["a"])).toBe(false);
  });
});

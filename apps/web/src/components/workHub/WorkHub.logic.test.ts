import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AxisContextCatalog } from "@t3tools/contracts";
import {
  buildWorkHubSourceGroups,
  buildWorkHubSourceReadiness,
  buildWorkHubWeekDays,
  workHubCurrentTimePercentage,
} from "./WorkHub.logic";

const decodeCatalog = Schema.decodeUnknownSync(AxisContextCatalog);
const now = "2026-09-05T00:00:00.000Z";

describe("buildWorkHubSourceReadiness", () => {
  it("includes provider MCPs only in contexts that may access that provider", () => {
    const catalog = decodeCatalog({
      contexts: [
        { id: "personal", kind: "personal", name: "Personal", createdAt: now, updatedAt: now },
        { id: "company_a", kind: "company", name: "Company A", createdAt: now, updatedAt: now },
        { id: "company_b", kind: "company", name: "Company B", createdAt: now, updatedAt: now },
      ],
      providerOwnerships: [
        { contextId: "personal", provider: { environmentId: "env", instanceId: "codex" } },
        { contextId: "company_a", provider: { environmentId: "env", instanceId: "claude" } },
      ],
      providerAccessGrants: [
        {
          id: "codex_to_b",
          ownerContextId: "personal",
          targetContextId: "company_b",
          provider: { environmentId: "env", instanceId: "codex" },
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      ],
      capabilities: [
        {
          id: "personal_jira",
          provider: { environmentId: "env", instanceId: "codex" },
          kind: "mcp",
          name: "Jira",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "company_slack",
          provider: { environmentId: "env", instanceId: "claude" },
          kind: "mcp",
          name: "Slack",
          createdAt: now,
          updatedAt: now,
        },
      ],
      workHubSources: [
        {
          id: "company_b_personal_jira",
          contextId: "company_b",
          provider: { environmentId: "env", instanceId: "codex" },
          capabilityId: "personal_jira",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    expect(buildWorkHubSourceReadiness(catalog)).toMatchObject([
      {
        contextId: "personal",
        providerCount: 1,
        availableMcpCount: 1,
        selectedMcpCount: 0,
      },
      {
        contextId: "company_a",
        providerCount: 1,
        availableMcpCount: 1,
        selectedMcpCount: 0,
      },
      {
        contextId: "company_b",
        providerCount: 1,
        availableMcpCount: 1,
        selectedMcpCount: 1,
      },
    ]);
    const groups = buildWorkHubSourceGroups(catalog);
    expect(groups[1]?.providers[0]?.mcps.map((mcp) => mcp.id)).toEqual(["company_slack"]);
    expect([...groups[2]!.providers[0]!.selectedCapabilityIds]).toEqual(["personal_jira"]);
  });

  it("does not count disabled MCPs", () => {
    const catalog = decodeCatalog({
      contexts: [
        { id: "personal", kind: "personal", name: "Personal", createdAt: now, updatedAt: now },
      ],
      providerOwnerships: [
        { contextId: "personal", provider: { environmentId: "env", instanceId: "codex" } },
      ],
      capabilities: [
        {
          id: "disabled_jira",
          provider: { environmentId: "env", instanceId: "codex" },
          kind: "mcp",
          name: "Jira",
          enabled: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    expect(buildWorkHubSourceReadiness(catalog)[0]).toMatchObject({
      providerCount: 1,
      availableMcpCount: 0,
      selectedMcpCount: 0,
    });
  });
});

describe("Work Hub calendar", () => {
  it("navigates complete Sunday-to-Saturday weeks", () => {
    const anchor = new Date(2026, 8, 5, 12);
    expect(buildWorkHubWeekDays(anchor, -1).map((day) => day.getDate())).toEqual([
      23, 24, 25, 26, 27, 28, 29,
    ]);
    expect(buildWorkHubWeekDays(anchor, 1).map((day) => day.getDate())).toEqual([
      6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it("positions the current-time indicator within the day", () => {
    expect(workHubCurrentTimePercentage(new Date(2026, 8, 5, 12))).toBe(50);
  });
});

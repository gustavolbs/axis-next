import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AxisContextCatalog, AxisWorkHubCachedItem } from "@t3tools/contracts";
import {
  buildWorkHubSourceGroups,
  buildWorkHubSourceReadiness,
  buildWorkHubWeekDays,
  isWorkHubOverviewItem,
  layoutWorkHubCalendarEvents,
  resolveWorkHubCalendarMeetingLink,
  resolveWorkHubBoardColumn,
  WORK_HUB_BOARD_COLUMNS,
  workHubCurrentTimePercentage,
} from "./WorkHub.logic";

const decodeCatalog = Schema.decodeUnknownSync(AxisContextCatalog);
const decodeItem = Schema.decodeUnknownSync(AxisWorkHubCachedItem);
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

  it("lays overlapping events into deterministic side-by-side columns", () => {
    const intervals = [
      { value: "short", sortKey: "b", startMinute: 600, endMinute: 630 },
      { value: "long", sortKey: "a", startMinute: 540, endMinute: 660 },
      { value: "after-short", sortKey: "c", startMinute: 630, endMinute: 720 },
    ];

    expect(layoutWorkHubCalendarEvents(intervals)).toEqual([
      { ...intervals[1], column: 0, columnCount: 2 },
      { ...intervals[0], column: 1, columnCount: 2 },
      { ...intervals[2], column: 1, columnCount: 2 },
    ]);
    expect(layoutWorkHubCalendarEvents(intervals.toReversed())).toEqual(
      layoutWorkHubCalendarEvents(intervals),
    );
  });

  it("reuses full width after an overlap cluster ends", () => {
    expect(
      layoutWorkHubCalendarEvents([
        { value: "first", sortKey: "a", startMinute: 540, endMinute: 600 },
        { value: "overlap", sortKey: "b", startMinute: 570, endMinute: 630 },
        { value: "touching", sortKey: "c", startMinute: 630, endMinute: 660 },
      ]),
    ).toEqual([
      { value: "first", sortKey: "a", startMinute: 540, endMinute: 600, column: 0, columnCount: 2 },
      {
        value: "overlap",
        sortKey: "b",
        startMinute: 570,
        endMinute: 630,
        column: 1,
        columnCount: 2,
      },
      {
        value: "touching",
        sortKey: "c",
        startMinute: 630,
        endMinute: 660,
        column: 0,
        columnCount: 1,
      },
    ]);
  });

  it("resolves explicit and recognized meeting links without linking arbitrary locations", () => {
    const event = decodeItem({
      id: "calendar-1",
      sourceId: "calendar",
      contextId: "personal",
      kind: "calendar-event",
      view: "calendar",
      nativeId: "event-1",
      title: "Planning",
      meetingLink: "https://custom.example/join/123",
      location: "Room 12",
      startsAt: now,
      updatedAt: now,
    });

    expect(resolveWorkHubCalendarMeetingLink(event)).toBe("https://custom.example/join/123");
    expect(
      resolveWorkHubCalendarMeetingLink({
        ...event,
        meetingLink: null,
        location: "https://acme.zoom.us/j/123",
      }),
    ).toBe("https://acme.zoom.us/j/123");
    expect(
      resolveWorkHubCalendarMeetingLink({
        ...event,
        meetingLink: null,
        location: "https://example.com/office",
      }),
    ).toBeNull();
  });
});

describe("Work Hub board", () => {
  it("keeps all six product columns and does not disguise unknown states as To do", () => {
    expect(WORK_HUB_BOARD_COLUMNS).toEqual([
      "To do",
      "Working",
      "Blocked",
      "Code review",
      "QA",
      "Done",
    ]);
    expect(resolveWorkHubBoardColumn("IN_PROGRESS")).toBe("Working");
    expect(resolveWorkHubBoardColumn("Ready for review")).toBe("Code review");
    expect(resolveWorkHubBoardColumn("released")).toBe("Unmapped");
    expect(resolveWorkHubBoardColumn(null)).toBe("Unmapped");
  });

  it("includes active work in Overview while excluding completed work", () => {
    const item = decodeItem({
      id: "jira-1",
      sourceId: "jira",
      contextId: "company_a",
      kind: "assigned-work-item",
      view: "board",
      nativeId: "AXIS-1",
      title: "Ship Work Hub",
      status: "In progress",
      updatedAt: now,
    });
    const today = new Date(2026, 8, 5, 12);

    expect(isWorkHubOverviewItem(item, today)).toBe(true);
    expect(isWorkHubOverviewItem({ ...item, status: "Done" }, today)).toBe(false);
  });
});

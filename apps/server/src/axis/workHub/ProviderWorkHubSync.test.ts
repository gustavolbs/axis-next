import { describe, expect, it } from "vite-plus/test";
import { AxisWorkHubCollectInput, AxisWorkHubCollectionResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  buildAxisWorkHubCacheSnapshot,
  buildClaudeWorkHubToolArgs,
  buildCollectionPrompt,
} from "./ProviderWorkHubSync.ts";

const decodeInput = Schema.decodeUnknownSync(AxisWorkHubCollectInput);
const decodeResult = Schema.decodeUnknownSync(AxisWorkHubCollectionResult);
const now = Date.parse("2026-09-05T12:00:00.000Z");
const baseItem = {
  summary: null,
  occurredAt: null,
  startsAt: null,
  endsAt: null,
  status: null,
  assignee: null,
  priority: null,
  dueDate: null,
  labels: [],
  project: null,
  sourceUpdatedAt: null,
  deepLink: null,
  meetingLink: null,
  location: null,
};

describe("buildAxisWorkHubCacheSnapshot", () => {
  it("keeps only focused recent data and creates an eight-hour snapshot", () => {
    const request = decodeInput({
      sourceId: "personal_connector",
      contextId: "personal",
      provider: { environmentId: "env", instanceId: "codex" },
      capabilityId: "connector",
      mcpName: "Work tools",
      collectionPolicy: {
        calendarLookbackDays: 14,
        calendarLookaheadDays: 90,
        assignedWorkItemsOnly: true,
        directMessages: true,
        mentions: true,
        assignedIssueComments: true,
      },
      cacheTtlSeconds: 28_800,
      previousCursor: null,
      previousRefreshedAt: "2026-09-04T12:00:00.000Z",
    });
    const result = decodeResult({
      cursor: "next-page",
      items: [
        {
          ...baseItem,
          kind: "calendar-event",
          view: "calendar",
          nativeId: "recent-event",
          title: "Planning",
          startsAt: "2026-09-06T12:00:00.000Z",
          endsAt: "2026-09-06T13:00:00.000Z",
          meetingLink: "https://meet.example.com/planning",
        },
        {
          ...baseItem,
          kind: "calendar-event",
          view: "calendar",
          nativeId: "continuing-event",
          title: "Continuing event",
          startsAt: "2026-08-20T12:00:00.000Z",
          endsAt: "2026-09-06T13:00:00.000Z",
          allDay: false,
        },
        {
          ...baseItem,
          kind: "calendar-event",
          view: "calendar",
          nativeId: "all-day-event",
          title: "Company holiday",
          allDay: true,
          startDate: "2026-08-20",
          endDate: "2026-09-06",
        },
        {
          ...baseItem,
          kind: "calendar-event",
          view: "calendar",
          nativeId: "event-from-2012",
          title: "Ancient event",
          startsAt: "2012-01-01T12:00:00.000Z",
        },
        {
          ...baseItem,
          kind: "assigned-work-item",
          view: "board",
          nativeId: "AXIS-42",
          title: "Assigned ticket",
          status: "In Progress",
          assignee: "Ada Lovelace",
          priority: "High",
          dueDate: "2026-09-12T00:00:00.000Z",
          labels: ["frontend", "urgent"],
          project: "Axis",
          sourceUpdatedAt: "2026-09-05T11:00:00.000Z",
          deepLink: "javascript:alert(1)",
        },
        {
          ...baseItem,
          kind: "assigned-work-item",
          view: "board",
          nativeId: "AXIS-41",
          title: "Finished ticket",
          status: "Done",
        },
        {
          ...baseItem,
          kind: "direct-message",
          view: "messages",
          nativeId: "old-dm",
          title: "Old direct message",
          occurredAt: "2026-09-03T12:00:00.000Z",
        },
        {
          ...baseItem,
          kind: "mention",
          view: "messages",
          nativeId: "new-mention",
          title: "New mention",
          occurredAt: "2026-09-05T10:00:00.000Z",
        },
      ],
    });

    const snapshot = buildAxisWorkHubCacheSnapshot({ request, result, nowEpochMs: now });

    expect(snapshot.items.map((item) => item.nativeId)).toEqual([
      "recent-event",
      "continuing-event",
      "all-day-event",
      "AXIS-42",
      "new-mention",
    ]);
    expect(snapshot.items[0]?.meetingLink).toBe("https://meet.example.com/planning");
    expect(snapshot.items[1]?.deepLink).toBeNull();
    expect(snapshot.items[3]).toMatchObject({
      assignee: "Ada Lovelace",
      priority: "High",
      dueDate: "2026-09-12T00:00:00.000Z",
      labels: ["frontend", "urgent"],
      project: "Axis",
      sourceUpdatedAt: "2026-09-05T11:00:00.000Z",
    });
    expect(snapshot.cursor).toBe("next-page");
    expect(snapshot.refreshedAt).toBe("2026-09-05T12:00:00.000Z");
    expect(snapshot.expiresAt).toBe("2026-09-05T20:00:00.000Z");
  });

  it("keeps only non-empty calendar intervals that intersect the half-open window", () => {
    const request = decodeInput({
      sourceId: "personal_connector",
      contextId: "personal",
      provider: { environmentId: "env", instanceId: "codex" },
      capabilityId: "connector",
      mcpName: "Work tools",
      collectionPolicy: {
        calendarLookbackDays: 1,
        calendarLookaheadDays: 1,
        assignedWorkItemsOnly: false,
        directMessages: false,
        mentions: false,
        assignedIssueComments: false,
      },
      cacheTtlSeconds: 28_800,
      previousCursor: null,
      previousRefreshedAt: null,
    });
    const result = decodeResult({
      cursor: null,
      items: [
        {
          ...baseItem,
          kind: "calendar-event",
          view: "calendar",
          nativeId: "at-upper-bound",
          title: "Outside",
          startsAt: "2026-09-06T12:00:00.000Z",
          endsAt: "2026-09-06T13:00:00.000Z",
        },
        {
          ...baseItem,
          kind: "calendar-event",
          view: "calendar",
          nativeId: "inverted",
          title: "Invalid",
          startsAt: "2026-09-05T13:00:00.000Z",
          endsAt: "2026-09-05T12:00:00.000Z",
        },
        {
          ...baseItem,
          kind: "calendar-event",
          view: "calendar",
          nativeId: "malformed-all-day",
          title: "Missing civil range",
          allDay: true,
        },
        {
          ...baseItem,
          kind: "calendar-event",
          view: "calendar",
          nativeId: "all-day-no-time",
          title: "Today",
          allDay: true,
          startDate: "2026-09-05",
          endDate: "2026-09-06",
        },
      ],
    });

    expect(buildAxisWorkHubCacheSnapshot({ request, result, nowEpochMs: now }).items).toHaveLength(
      1,
    );
    expect(
      buildAxisWorkHubCacheSnapshot({ request, result, nowEpochMs: now }).items[0]?.nativeId,
    ).toBe("all-day-no-time");
  });
});

describe("buildCollectionPrompt", () => {
  const request = decodeInput({
    sourceId: "personal_connector",
    contextId: "personal",
    provider: { environmentId: "env", instanceId: "claude" },
    capabilityId: "connector",
    mcpName: "Work tools",
    collectionPolicy: {
      calendarLookbackDays: 14,
      calendarLookaheadDays: 90,
      assignedWorkItemsOnly: true,
      directMessages: true,
      mentions: true,
      assignedIssueComments: true,
    },
    cacheTtlSeconds: 28_800,
    previousCursor: null,
    previousRefreshedAt: "2026-09-04T12:00:00.000Z",
  });

  it("uses the source calendar policy in one contiguous provider query", () => {
    const prompt = buildCollectionPrompt(request, now);
    const bounds = prompt.match(/start: "([^"]+)" end: "([^"]+)"/u);

    expect(bounds).not.toBeNull();
    expect(Date.parse(bounds![1]!)).toBe(now - 14 * 86_400_000);
    expect(Date.parse(bounds![2]!)).toBe(now + 90 * 86_400_000);
    // The old prompt emitted a numbered slice list; one range means one query.
    expect(prompt).not.toMatch(/PER SLICE/u);
    expect(prompt.match(/afterDateTime/gu)).toHaveLength(1);
  });

  it("names the known connector tools so discovery costs one ToolSearch", () => {
    const prompt = buildCollectionPrompt(request, now);

    expect(prompt).toContain("select:");
    expect(prompt).toContain("jira_search");
    expect(prompt).toContain("outlook_calendar_search");
    expect(prompt).toContain("slack_search_public_and_private");
    expect(prompt).toContain("after:2026-09-04");
    expect(prompt).toContain("sourceUpdatedAt");
    expect(prompt).toContain("assignee");
  });
});

describe("buildClaudeWorkHubToolArgs", () => {
  it("allows the selected MCP under both scopes without a discovery round-trip", () => {
    expect(buildClaudeWorkHubToolArgs("Microsoft 365")).toEqual([
      "--allowedTools",
      "Read",
      "ToolSearch",
      "mcp__Microsoft_365",
      "mcp__Microsoft_365__*",
      "mcp__claude_ai_Microsoft_365",
      "mcp__claude_ai_Microsoft_365__*",
    ]);
  });
});

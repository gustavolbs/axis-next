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
  it("keeps provider-selected data and creates an eight-hour snapshot", () => {
    const request = decodeInput({
      sourceId: "personal_connector",
      contextId: "personal",
      provider: { environmentId: "env", instanceId: "codex" },
      capabilityId: "connector",
      mcpName: "Work tools",
      collectionPolicy: {
        prompt: "",
      },
      cacheTtlSeconds: 28_800,
      previousCursor: null,
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
          sourceTimeZone: "America/Los_Angeles",
          calendar: { nativeId: "primary", name: "Work" },
          organizer: { name: "Grace Hopper", email: "grace@example.com" },
          participants: [
            {
              name: "Ada Lovelace",
              email: "ada@example.com",
              responseStatus: "accepted",
            },
          ],
          responseStatus: "tentative",
          recurrence: { seriesId: "planning-series", rule: "FREQ=WEEKLY" },
          cancelled: false,
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
      "event-from-2012",
      "AXIS-42",
      "AXIS-41",
      "old-dm",
      "new-mention",
    ]);
    expect(snapshot.items[0]?.meetingLink).toBe("https://meet.example.com/planning");
    expect(snapshot.items[0]).toMatchObject({
      sourceTimeZone: "America/Los_Angeles",
      calendar: { nativeId: "primary", name: "Work" },
      organizer: { name: "Grace Hopper", email: "grace@example.com" },
      participants: [
        { name: "Ada Lovelace", email: "ada@example.com", responseStatus: "accepted" },
      ],
      responseStatus: "tentative",
      recurrence: { seriesId: "planning-series", rule: "FREQ=WEEKLY" },
      cancelled: false,
    });
    expect(snapshot.items[1]?.deepLink).toBeNull();
    expect(snapshot.items[4]).toMatchObject({
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

  it("does not apply hidden calendar filters to provider results", () => {
    const request = decodeInput({
      sourceId: "personal_connector",
      contextId: "personal",
      provider: { environmentId: "env", instanceId: "codex" },
      capabilityId: "connector",
      mcpName: "Work tools",
      collectionPolicy: {
        prompt: "",
      },
      cacheTtlSeconds: 28_800,
      previousCursor: null,
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
      4,
    );
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
      prompt: "Find upcoming customer meetings and open support tickets.",
    },
    cacheTtlSeconds: 28_800,
    previousCursor: null,
  });

  it("uses the source prompt as the only search criterion", () => {
    const prompt = buildCollectionPrompt(request);

    expect(prompt).toContain("Find upcoming customer meetings and open support tickets.");
    expect(prompt).toContain("sole criterion");
    expect(prompt).not.toContain("afterDateTime");
    expect(prompt).not.toContain("calendarLookbackDays");
  });

  it("keeps provider safety and the structured output contract", () => {
    const prompt = buildCollectionPrompt(request);

    expect(prompt).toContain('MCP server named "Work tools"');
    expect(prompt).toContain("ToolSearch");
    expect(prompt).toContain("read-only, source-scoped, and structured-output requirements");
    expect(prompt).toContain(
      "Always finish by returning the structured JSON result instead of prose.",
    );
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

import { describe, expect, it } from "vite-plus/test";
import { AxisWorkHubCollectInput, AxisWorkHubCollectionResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  buildAxisWorkHubCacheSnapshot,
  buildClaudeWorkHubToolArgs,
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
          deepLink: "javascript:alert(1)",
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
      "AXIS-42",
      "new-mention",
    ]);
    expect(snapshot.items[0]?.meetingLink).toBe("https://meet.example.com/planning");
    expect(snapshot.items[1]?.deepLink).toBeNull();
    expect(snapshot.cursor).toBe("next-page");
    expect(snapshot.refreshedAt).toBe("2026-09-05T12:00:00.000Z");
    expect(snapshot.expiresAt).toBe("2026-09-05T20:00:00.000Z");
  });
});

describe("buildClaudeWorkHubToolArgs", () => {
  it("loads the selected claude.ai MCP with its native namespace", () => {
    expect(
      buildClaudeWorkHubToolArgs({ name: "Microsoft 365", scope: "claude.ai" }, [
        { name: "Microsoft 365", scope: "claude.ai" },
        { name: "LN Jira", scope: "claude.ai" },
        { name: "local-coder", scope: "local" },
      ]),
    ).toEqual([
      "--tools",
      "Read,mcp__claude_ai_Microsoft_365__*",
      "--allowedTools",
      "Read",
      "mcp__claude_ai_Microsoft_365__*",
      "--disallowedTools",
      "mcp__claude_ai_LN_Jira__*",
      "mcp__local-coder__*",
    ]);
  });
});

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import {
  AxisWorkHubCollectInput,
  AxisWorkHubCollectionResult,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  AXIS_WORK_HUB_READ_ONLY_TOOL_NAMES,
  buildAxisWorkHubCacheSnapshot,
  buildClaudeWorkHubToolArgs,
  buildCollectionPrompt,
  codexWorkHubMcpOverrides,
  collectTrelloWorkHubSource,
  ensureSelectedMcpIsUsable,
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

describe("collectTrelloWorkHubSource", () => {
  it.effect("runs the native adapter in the provider collection path", () =>
    Effect.gen(function* () {
      const request = decodeInput({
        sourceId: "trello_source",
        contextId: "work",
        provider: { environmentId: "env", instanceId: "codex-trello" },
        capabilityId: "trello-read",
        mcpName: "Trello",
        collectionPolicy: { prompt: "Open cards" },
        cacheTtlSeconds: 28_800,
        previousCursor: null,
      });
      const snapshot = yield* collectTrelloWorkHubSource({
        request,
        options: {
          driver: ProviderDriverKind.make("codex"),
          instanceId: ProviderInstanceId.make("codex-trello"),
          availableMcps: [
            {
              name: "Trello",
              status: "connected",
              enabled: true,
            },
          ],
        },
        readCards: (input) =>
          Effect.succeed({
            cards: [
              {
                id: "card-1",
                name: "Ship it",
                list: { name: "Doing" },
                labels: [{ name: "release" }],
              },
              { id: "card-2", name: "Needs triage", status: "Waiting", labels: [] },
            ],
            cursor: input.cursor === null ? "next-page" : null,
          }),
        nowEpochMs: Date.parse("2026-09-10T12:00:00.000Z"),
      });
      expect(snapshot.items.map((item) => [item.nativeId, item.status])).toEqual([
        ["card-1", "in-progress"],
        ["card-2", "Waiting"],
      ]);
      expect(snapshot.items[0]?.statusMapping).toEqual({
        kind: "mapped",
        native: "Doing",
        value: "in-progress",
      });
      expect(snapshot.items[1]?.statusMapping).toEqual({
        kind: "unmapped",
        native: "Waiting",
      });
      expect(snapshot.items.map((item) => item.id)).toEqual([
        "trello_source:assigned-work-item:card-1",
        "trello_source:assigned-work-item:card-2",
      ]);
      expect(snapshot.cursor).toBe("next-page");
    }),
  );
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
  it("allows only declared read-only operations in the selected local scope", () => {
    expect(buildClaudeWorkHubToolArgs({ name: "Microsoft 365", scope: "local" })).toEqual([
      "--allowedTools",
      "ToolSearch",
      "mcp__Microsoft_365__get_cards",
      "mcp__Microsoft_365__get_card",
      "mcp__Microsoft_365__get_lists",
      "mcp__Microsoft_365__get_list",
      "mcp__Microsoft_365__search_cards",
      "mcp__Microsoft_365__get_events",
      "mcp__Microsoft_365__list_events",
      "mcp__Microsoft_365__search_events",
      "mcp__Microsoft_365__get_messages",
      "mcp__Microsoft_365__list_messages",
      "mcp__Microsoft_365__search_messages",
      "mcp__Microsoft_365__get_issues",
      "mcp__Microsoft_365__list_issues",
      "mcp__Microsoft_365__search_issues",
      "mcp__Microsoft_365__get_tasks",
      "mcp__Microsoft_365__list_tasks",
      "mcp__Microsoft_365__search_tasks",
    ]);
    expect(buildClaudeWorkHubToolArgs({ name: "Microsoft 365", scope: "local" })).not.toContain(
      "Read",
    );
  });

  it("selects only the exact claude.ai scope", () => {
    const args = buildClaudeWorkHubToolArgs({ name: "Microsoft 365", scope: "claude.ai" });
    expect(args).toContain("mcp__claude_ai_Microsoft_365__get_cards");
    expect(args).not.toContain("mcp__Microsoft_365__get_cards");
  });

  it("rejects absent or unhealthy MCP inventory entries", () => {
    const base = { name: "Trello", status: "connected", enabled: true } as const;
    expect(
      ensureSelectedMcpIsUsable(
        {
          driver: ProviderDriverKind.make("codex"),
          instanceId: ProviderInstanceId.make("codex"),
          availableMcps: [],
        },
        "Trello",
      ),
    ).toContain("not found");
    expect(
      ensureSelectedMcpIsUsable(
        {
          driver: ProviderDriverKind.make("codex"),
          instanceId: ProviderInstanceId.make("codex"),
          availableMcps: [{ ...base, status: "failed" }],
        },
        "Trello",
      ),
    ).toContain("not authorized");
    expect(
      ensureSelectedMcpIsUsable(
        {
          driver: ProviderDriverKind.make("codex"),
          instanceId: ProviderInstanceId.make("codex"),
          availableMcps: [base],
        },
        "Trello",
      ),
    ).toBeUndefined();
    expect(
      ensureSelectedMcpIsUsable(
        {
          driver: ProviderDriverKind.make("claudeAgent"),
          instanceId: ProviderInstanceId.make("claude"),
          availableMcps: [
            { ...base, scope: "local" },
            { ...base, scope: "claude.ai" },
          ],
        },
        "Trello",
      ),
    ).toContain("ambiguous");
    expect(
      ensureSelectedMcpIsUsable(
        {
          driver: ProviderDriverKind.make("claudeAgent"),
          instanceId: ProviderInstanceId.make("claude"),
          availableMcps: [
            { ...base, name: "Trello Board", scope: "local" },
            { ...base, name: "Trello_Board", scope: "local" },
          ],
        },
        "Trello Board",
      ),
    ).toContain("normalization");
  });

  it("freezes the read-only operation declaration at runtime", () => {
    expect(Object.isFrozen(AXIS_WORK_HUB_READ_ONLY_TOOL_NAMES)).toBe(true);
  });

  it("configures Codex with an exact operation allowlist", () => {
    const args = codexWorkHubMcpOverrides(
      [
        { name: "Trello", status: "configured", enabled: true },
        { name: "Other", status: "configured", enabled: true },
      ],
      "Trello",
    );
    expect(args.join(" ")).toContain('mcp_servers."Trello".enabled_tools=["get_cards"');
    expect(args.join(" ")).not.toContain("enabled_tools=\"*");
    expect(args).toContain('mcp_servers."Other".enabled=false');
  });
});

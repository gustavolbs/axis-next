import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AxisWorkHubCacheSnapshot,
  AxisWorkHubCalendarDate,
  AxisWorkHubSourceStatus,
  isAxisWorkHubCacheFresh,
} from "./axisWorkHub.ts";

const decodeSnapshot = Schema.decodeUnknownSync(AxisWorkHubCacheSnapshot);
const decodeCalendarDate = Schema.decodeUnknownSync(AxisWorkHubCalendarDate);
const decodeSourceStatus = Schema.decodeUnknownSync(AxisWorkHubSourceStatus);

describe("AxisWorkHubCalendarDate", () => {
  it("accepts valid civil dates and rejects impossible month/day combinations", () => {
    expect(decodeCalendarDate("2024-02-29")).toBe("2024-02-29");
    expect(() => decodeCalendarDate("2026-02-29")).toThrow();
    expect(() => decodeCalendarDate("2026-13-01")).toThrow();
  });
});

describe("AxisWorkHubCacheSnapshot", () => {
  it("serves a confirmed source snapshot until its TTL expires", () => {
    const snapshot = decodeSnapshot({
      sourceId: "jira_company_a",
      contextId: "company_a",
      provider: { environmentId: "env", instanceId: "codex" },
      capabilityId: "jira",
      items: [],
      refreshedAt: "2026-09-05T00:00:00.000Z",
      expiresAt: "2026-09-05T08:00:00.000Z",
    });

    expect(isAxisWorkHubCacheFresh(snapshot, Date.parse("2026-09-05T07:59:59.000Z"))).toBe(true);
    expect(isAxisWorkHubCacheFresh(snapshot, Date.parse("2026-09-05T08:00:00.000Z"))).toBe(false);
    expect(snapshot.cursor).toBeNull();
  });

  it("represents an unconfirmed source as stale without inventing cache data", () => {
    expect(
      decodeSourceStatus({
        sourceId: "jira_company_a",
        status: "stale",
        lastConfirmedSuccessAt: null,
        lastErrorAt: null,
        lastErrorKind: null,
        lastErrorMessage: null,
        snapshot: null,
      }),
    ).toMatchObject({ status: "stale", snapshot: null });
  });
});

import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AxisWorkHubCacheSnapshot, isAxisWorkHubCacheFresh } from "./axisWorkHub.ts";

const decodeSnapshot = Schema.decodeUnknownSync(AxisWorkHubCacheSnapshot);

describe("AxisWorkHubCacheSnapshot", () => {
  it("serves a confirmed source snapshot until its TTL expires", () => {
    const snapshot = decodeSnapshot({
      sourceId: "jira_company_a",
      contextId: "company_a",
      provider: { environmentId: "env", instanceId: "codex" },
      capabilityId: "jira",
      items: [],
      refreshedAt: "2026-09-05T00:00:00.000Z",
      expiresAt: "2026-09-05T00:15:00.000Z",
    });

    expect(isAxisWorkHubCacheFresh(snapshot, Date.parse("2026-09-05T00:14:59.000Z"))).toBe(true);
    expect(isAxisWorkHubCacheFresh(snapshot, Date.parse("2026-09-05T00:15:00.000Z"))).toBe(false);
    expect(snapshot.cursor).toBeNull();
  });
});

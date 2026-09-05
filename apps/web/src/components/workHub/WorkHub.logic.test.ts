import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AxisContextCatalog } from "@t3tools/contracts";
import { buildWorkHubSourceReadiness } from "./WorkHub.logic";

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
    });

    expect(buildWorkHubSourceReadiness(catalog)).toMatchObject([
      { contextId: "personal", providerCount: 1, mcpCount: 1 },
      { contextId: "company_a", providerCount: 1, mcpCount: 1 },
      { contextId: "company_b", providerCount: 1, mcpCount: 1 },
    ]);
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
      mcpCount: 0,
    });
  });
});

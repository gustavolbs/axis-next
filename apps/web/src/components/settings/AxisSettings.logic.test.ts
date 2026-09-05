import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AxisContextCatalog, AxisContextId } from "@t3tools/contracts";
import { removeAxisCompany } from "./AxisSettings.logic";

const decodeCatalog = Schema.decodeUnknownSync(AxisContextCatalog);
const now = "2026-09-05T00:00:00.000Z";

describe("removeAxisCompany", () => {
  it("cascades only relationships belonging to the removed company", () => {
    const catalog = decodeCatalog({
      contexts: [
        { id: "personal", kind: "personal", name: "Personal", createdAt: now, updatedAt: now },
        { id: "company_a", kind: "company", name: "Company A", createdAt: now, updatedAt: now },
        { id: "company_b", kind: "company", name: "Company B", createdAt: now, updatedAt: now },
      ],
      providerOwnerships: [
        { contextId: "company_a", provider: { environmentId: "env", instanceId: "claude" } },
        { contextId: "company_b", provider: { environmentId: "env", instanceId: "codex" } },
      ],
      capabilities: [
        {
          id: "a_skill",
          ownerContextId: "company_a",
          kind: "skill",
          name: "A skill",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "b_mcp",
          ownerContextId: "company_b",
          kind: "mcp",
          name: "B MCP",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    const result = removeAxisCompany(catalog, AxisContextId.make("company_a"));

    expect(result.contexts.map((context) => context.id)).toEqual(["personal", "company_b"]);
    expect(result.providerOwnerships.map((ownership) => ownership.contextId)).toEqual([
      "company_b",
    ]);
    expect(result.capabilities.map((capability) => capability.id)).toEqual(["b_mcp"]);
  });
});

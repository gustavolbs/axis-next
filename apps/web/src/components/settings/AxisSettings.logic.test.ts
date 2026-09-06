import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AxisContextCatalog,
  AxisContextId,
  AxisProjectLocator,
  AxisProviderAccessGrantId,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import {
  removeAxisCompany,
  removeAxisProviderAccessGrant,
  setAxisProjectContext,
  setAxisProviderOwner,
} from "./AxisSettings.logic";

const decodeCatalog = Schema.decodeUnknownSync(AxisContextCatalog);
const now = "2026-09-05T00:00:00.000Z";

describe("removeAxisCompany", () => {
  it("removes the company's providers and their capabilities without affecting another company", () => {
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
      projectBindings: [
        { contextId: "company_a", project: { environmentId: "env", projectId: "project_a" } },
        { contextId: "company_b", project: { environmentId: "env", projectId: "project_b" } },
      ],
      capabilities: [
        {
          id: "a_skill",
          provider: { environmentId: "env", instanceId: "claude" },
          kind: "skill",
          name: "A skill",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "b_mcp",
          provider: { environmentId: "env", instanceId: "codex" },
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
    expect(result.projectBindings.map((binding) => binding.project.projectId)).toEqual([
      "project_b",
    ]);
    expect(result.capabilities.map((capability) => capability.id)).toEqual(["b_mcp"]);
  });
});

describe("Axis Project context", () => {
  it("assigns, reassigns, and removes one Project binding without duplicates", () => {
    const catalog = decodeCatalog({
      contexts: [
        { id: "personal", kind: "personal", name: "Personal", createdAt: now, updatedAt: now },
        { id: "company_a", kind: "company", name: "Company A", createdAt: now, updatedAt: now },
      ],
    });
    const project = AxisProjectLocator.make({
      environmentId: EnvironmentId.make("env"),
      projectId: ProjectId.make("project_a"),
    });

    const personal = setAxisProjectContext(catalog, project, AxisContextId.make("personal"));
    const company = setAxisProjectContext(personal, project, AxisContextId.make("company_a"));
    const removed = setAxisProjectContext(company, project, null);

    expect(personal.projectBindings).toEqual([{ contextId: "personal", project }]);
    expect(company.projectBindings).toEqual([{ contextId: "company_a", project }]);
    expect(removed.projectBindings).toEqual([]);
  });
});

describe("Axis provider ownership", () => {
  function personalProviderCatalog() {
    return decodeCatalog({
      contexts: [
        { id: "personal", kind: "personal", name: "Personal", createdAt: now, updatedAt: now },
        { id: "company_a", kind: "company", name: "Company A", createdAt: now, updatedAt: now },
      ],
      providerOwnerships: [
        { contextId: "personal", provider: { environmentId: "env", instanceId: "codex" } },
      ],
      providerAccessGrants: [
        {
          id: "provider_grant",
          ownerContextId: "personal",
          targetContextId: "company_a",
          provider: { environmentId: "env", instanceId: "codex" },
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      ],
      capabilities: [
        {
          id: "skill",
          provider: { environmentId: "env", instanceId: "codex" },
          kind: "mcp",
          name: "Jira",
          createdAt: now,
          updatedAt: now,
        },
      ],
      workHubSources: [
        {
          id: "work_hub_source",
          contextId: "company_a",
          provider: { environmentId: "env", instanceId: "codex" },
          capabilityId: "skill",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
  }

  it("drops access grants but preserves provider capabilities when ownership changes", () => {
    const catalog = personalProviderCatalog();
    const provider = catalog.providerOwnerships[0]!.provider;

    const reassigned = setAxisProviderOwner(catalog, provider, AxisContextId.make("company_a"));

    expect(reassigned.providerOwnerships[0]?.contextId).toBe("company_a");
    expect(reassigned.providerAccessGrants).toEqual([]);
    expect(reassigned.capabilities.map((capability) => capability.id)).toEqual(["skill"]);
    expect(reassigned.workHubSources).toEqual([]);
  });

  it("preserves access grants when the provider owner does not change", () => {
    const catalog = personalProviderCatalog();
    const result = setAxisProviderOwner(
      catalog,
      catalog.providerOwnerships[0]!.provider,
      AxisContextId.make("personal"),
    );

    expect(result).toBe(catalog);
    expect(result.providerAccessGrants).toHaveLength(1);
  });

  it("removes company access without changing capabilities attached to the provider", () => {
    const catalog = personalProviderCatalog();

    const result = removeAxisProviderAccessGrant(
      catalog,
      AxisProviderAccessGrantId.make("provider_grant"),
    );

    expect(result.providerAccessGrants).toEqual([]);
    expect(result.capabilities.map((capability) => capability.id)).toEqual(["skill"]);
    expect(result.workHubSources).toEqual([]);
  });
});

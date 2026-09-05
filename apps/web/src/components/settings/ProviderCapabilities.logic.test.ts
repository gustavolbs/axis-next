import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AxisCapabilityId,
  AxisContextCatalog,
  type AxisProviderInstanceLocator,
  validateAxisContextCatalog,
} from "@t3tools/contracts";
import {
  removeAxisProviderCapability,
  setAxisProviderCapabilityEnabled,
} from "./ProviderCapabilities.logic";

const decodeCatalog = Schema.decodeUnknownSync(AxisContextCatalog);
const now = "2026-09-05T00:00:00.000Z";
const later = "2026-09-05T01:00:00.000Z";
const codex = {
  environmentId: "env",
  instanceId: "codex",
} as AxisProviderInstanceLocator;
const claude = {
  environmentId: "env",
  instanceId: "claude",
} as AxisProviderInstanceLocator;

function catalog() {
  return decodeCatalog({
    contexts: [
      { id: "personal", kind: "personal", name: "Personal", createdAt: now, updatedAt: now },
      { id: "company", kind: "company", name: "Company", createdAt: now, updatedAt: now },
    ],
    providerOwnerships: [
      { contextId: "personal", provider: codex },
      { contextId: "company", provider: claude },
    ],
    capabilities: [
      {
        id: "codex_jira",
        provider: codex,
        kind: "mcp",
        name: "Jira",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "claude_skill",
        provider: claude,
        kind: "skill",
        name: "Review",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    workHubSources: [
      {
        id: "personal_jira",
        contextId: "personal",
        provider: codex,
        capabilityId: "codex_jira",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "company_jira",
        contextId: "company",
        provider: codex,
        capabilityId: "codex_jira",
        createdAt: now,
        updatedAt: now,
      },
    ],
    providerAccessGrants: [
      {
        id: "codex_company",
        ownerContextId: "personal",
        targetContextId: "company",
        provider: codex,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
}

describe("setAxisProviderCapabilityEnabled", () => {
  it("updates only a capability owned by the selected provider", () => {
    const result = setAxisProviderCapabilityEnabled({
      catalog: catalog(),
      provider: codex,
      capabilityId: AxisCapabilityId.make("codex_jira"),
      enabled: false,
      updatedAt: later,
    });

    expect(result.capabilities[0]).toMatchObject({ enabled: false, updatedAt: later });
    expect(result.capabilities[1]).toMatchObject({ enabled: true, updatedAt: now });
    expect(result.workHubSources).toEqual([
      expect.objectContaining({ id: "personal_jira", enabled: false, updatedAt: later }),
      expect.objectContaining({ id: "company_jira", enabled: false, updatedAt: later }),
    ]);
    expect(validateAxisContextCatalog(result)).toEqual([]);
  });

  it("does not mutate another provider's capability", () => {
    const original = catalog();
    const result = setAxisProviderCapabilityEnabled({
      catalog: original,
      provider: codex,
      capabilityId: AxisCapabilityId.make("claude_skill"),
      enabled: false,
      updatedAt: later,
    });

    expect(result).toBe(original);
  });

  it("does not silently restore Work Hub bindings when re-enabled", () => {
    const disabled = setAxisProviderCapabilityEnabled({
      catalog: catalog(),
      provider: codex,
      capabilityId: AxisCapabilityId.make("codex_jira"),
      enabled: false,
      updatedAt: later,
    });
    const result = setAxisProviderCapabilityEnabled({
      catalog: disabled,
      provider: codex,
      capabilityId: AxisCapabilityId.make("codex_jira"),
      enabled: true,
      updatedAt: "2026-09-05T02:00:00.000Z",
    });

    expect(result.capabilities[0]?.enabled).toBe(true);
    expect(result.workHubSources.every((source) => !source.enabled)).toBe(true);
  });
});

describe("removeAxisProviderCapability", () => {
  it("atomically removes the capability and every dependent Work Hub binding", () => {
    const result = removeAxisProviderCapability({
      catalog: catalog(),
      provider: codex,
      capabilityId: AxisCapabilityId.make("codex_jira"),
    });

    expect(result.capabilities.map((capability) => capability.id)).toEqual(["claude_skill"]);
    expect(result.workHubSources).toEqual([]);
    expect(result.providerAccessGrants).toHaveLength(1);
    expect(validateAxisContextCatalog(result)).toEqual([]);
  });

  it("does not remove a capability through the wrong provider", () => {
    const original = catalog();
    const result = removeAxisProviderCapability({
      catalog: original,
      provider: claude,
      capabilityId: AxisCapabilityId.make("codex_jira"),
    });

    expect(result).toBe(original);
  });
});

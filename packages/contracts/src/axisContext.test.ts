import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AxisContextCatalog,
  AxisContextId,
  resolveAxisContextCapabilities,
  resolveAxisContextProviderInstances,
  validateAxisContextCatalog,
} from "./axisContext.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

const decodeCatalog = Schema.decodeUnknownSync(AxisContextCatalog);
const now = "2026-09-05T00:00:00.000Z";

function validCatalog() {
  return decodeCatalog({
    contexts: [
      { id: "personal", kind: "personal", name: "Personal", createdAt: now, updatedAt: now },
      { id: "company_a", kind: "company", name: "Company A", createdAt: now, updatedAt: now },
      { id: "company_b", kind: "company", name: "Company B", createdAt: now, updatedAt: now },
    ],
    providerOwnerships: [
      {
        contextId: "personal",
        provider: { environmentId: "laptop", instanceId: "codex_personal" },
      },
      {
        contextId: "company_a",
        provider: { environmentId: "laptop", instanceId: "claude_enterprise" },
      },
      {
        contextId: "company_b",
        provider: { environmentId: "laptop", instanceId: "codex_enterprise" },
      },
    ],
    providerAccessGrants: [
      {
        id: "personal_codex_to_b",
        ownerContextId: "personal",
        targetContextId: "company_b",
        provider: { environmentId: "laptop", instanceId: "codex_personal" },
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ],
    capabilities: [
      {
        id: "personal_jira",
        ownerContextId: "personal",
        kind: "mcp",
        name: "Jira",
        portableToCompanies: true,
        compatibleDrivers: ["codex"],
        createdAt: now,
        updatedAt: now,
      },
    ],
    capabilityGrants: [
      {
        id: "personal_jira_to_b",
        capabilityId: "personal_jira",
        ownerContextId: "personal",
        targetContextId: "company_b",
        providerInstances: [{ environmentId: "laptop", instanceId: "codex_personal" }],
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
}

describe("AxisContextCatalog", () => {
  it("defaults collections and capability flags", () => {
    expect(decodeCatalog({})).toEqual({
      contexts: [],
      providerOwnerships: [],
      providerAccessGrants: [],
      capabilities: [],
      capabilityGrants: [],
    });

    const catalog = validCatalog();
    expect(catalog.capabilities[0]).toMatchObject({ enabled: true, portableToCompanies: true });
    expect(catalog.providerAccessGrants[0]?.revokedAt).toBeNull();
  });

  it("accepts a Personal-to-Company provider and capability grant", () => {
    expect(validateAxisContextCatalog(validCatalog())).toEqual([]);
  });

  it("keeps Company A and Company B provider access isolated", () => {
    const catalog = validCatalog();
    expect(
      resolveAxisContextProviderInstances(catalog, AxisContextId.make("company_a")).map(
        (provider) => provider.instanceId,
      ),
    ).toEqual(["claude_enterprise"]);
    expect(
      resolveAxisContextProviderInstances(catalog, AxisContextId.make("company_b")).map(
        (provider) => provider.instanceId,
      ),
    ).toEqual(["codex_enterprise", "codex_personal"]);
    expect(
      resolveAxisContextProviderInstances(catalog, AxisContextId.make("personal")).map(
        (provider) => provider.instanceId,
      ),
    ).toEqual(["codex_personal"]);
  });

  it("resolves Company capabilities only from its own context and explicit Personal grants", () => {
    const catalog = validCatalog();
    const companyBCapabilities = resolveAxisContextCapabilities({
      catalog,
      contextId: AxisContextId.make("company_b"),
      provider: catalog.providerOwnerships[0]!.provider,
      driver: ProviderDriverKind.make("codex"),
    });
    const companyACapabilities = resolveAxisContextCapabilities({
      catalog,
      contextId: AxisContextId.make("company_a"),
      provider: catalog.providerOwnerships[1]!.provider,
      driver: ProviderDriverKind.make("claudeAgent"),
    });

    expect(companyBCapabilities.map((capability) => capability.id)).toEqual(["personal_jira"]);
    expect(companyACapabilities).toEqual([]);
  });

  it("rejects Company-to-Company provider grants", () => {
    const catalog = validCatalog();
    const invalid = {
      ...catalog,
      providerAccessGrants: [
        {
          ...catalog.providerAccessGrants[0]!,
          ownerContextId: AxisContextId.make("company_a"),
          targetContextId: AxisContextId.make("company_b"),
          provider: catalog.providerOwnerships[1]!.provider,
        },
      ],
    };

    expect(validateAxisContextCatalog(invalid).map((issue) => issue.code)).toContain(
      "provider_grant_owner_not_personal",
    );
  });

  it("rejects non-portable capabilities and inaccessible provider bindings", () => {
    const catalog = validCatalog();
    const invalid = {
      ...catalog,
      capabilities: [{ ...catalog.capabilities[0]!, portableToCompanies: false }],
      capabilityGrants: [
        {
          ...catalog.capabilityGrants[0]!,
          providerInstances: [catalog.providerOwnerships[1]!.provider],
        },
      ],
    };
    const codes = validateAxisContextCatalog(invalid).map((issue) => issue.code);

    expect(codes).toContain("capability_not_portable");
    expect(codes).toContain("capability_provider_not_accessible");
  });

  it("requires exactly one Personal context and consistent revocation timestamps", () => {
    const catalog = validCatalog();
    const invalid = {
      ...catalog,
      contexts: catalog.contexts.filter((context) => context.kind !== "personal"),
      providerAccessGrants: [
        { ...catalog.providerAccessGrants[0]!, status: "revoked" as const, revokedAt: null },
      ],
    };
    const codes = validateAxisContextCatalog(invalid).map((issue) => issue.code);

    expect(codes).toContain("personal_context_count");
    expect(codes).toContain("revocation_state_mismatch");
  });
});

import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AxisContextCatalog,
  AxisContextId,
  AxisWorkHubSource,
  resolveAxisContextCapabilities,
  resolveAxisContextProviderInstances,
  validateAxisContextCatalog,
} from "./axisContext.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const decodeCatalog = Schema.decodeUnknownSync(AxisContextCatalog);
const decodeWorkHubSource = Schema.decodeUnknownSync(AxisWorkHubSource);
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
        provider: { environmentId: "laptop", instanceId: "codex_personal" },
        kind: "mcp",
        name: "Jira",
        compatibleDrivers: ["codex"],
        createdAt: now,
        updatedAt: now,
      },
    ],
    workHubSources: [
      {
        id: "company_b_jira",
        contextId: "company_b",
        provider: { environmentId: "laptop", instanceId: "codex_personal" },
        capabilityId: "personal_jira",
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
      workHubSources: [],
    });

    const catalog = validCatalog();
    expect(catalog.capabilities[0]).toMatchObject({ enabled: true });
    expect(catalog.workHubSources[0]).toMatchObject({
      enabled: true,
      cacheTtlSeconds: 28_800,
      collectionPolicy: {
        calendarLookbackDays: 60,
        calendarLookaheadDays: 90,
        assignedWorkItemsOnly: true,
        directMessages: true,
        mentions: true,
        assignedIssueComments: true,
      },
    });
    expect(catalog.providerAccessGrants[0]?.revokedAt).toBeNull();
  });

  it("upgrades legacy Work Hub cache entries to at least eight hours", () => {
    expect(
      decodeWorkHubSource({
        ...validCatalog().workHubSources[0],
        cacheTtlSeconds: 15 * 60,
      }).cacheTtlSeconds,
    ).toBe(28_800);
  });

  it("accepts a Personal-to-Company provider grant", () => {
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

  it("resolves capabilities from the provider available in the selected context", () => {
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

  it("rejects capabilities attached to an unowned provider", () => {
    const catalog = validCatalog();
    const invalid = {
      ...catalog,
      capabilities: [
        {
          ...catalog.capabilities[0]!,
          provider: {
            environmentId: catalog.providerOwnerships[0]!.provider.environmentId,
            instanceId: ProviderInstanceId.make("missing"),
          },
        },
      ],
    };
    const codes = validateAxisContextCatalog(invalid).map((issue) => issue.code);

    expect(codes).toContain("capability_provider_unowned");
  });

  it("rejects a Work Hub source when its context cannot access the selected provider", () => {
    const catalog = validCatalog();
    const invalid = {
      ...catalog,
      workHubSources: [
        {
          ...catalog.workHubSources[0]!,
          contextId: AxisContextId.make("company_a"),
        },
      ],
    };

    expect(validateAxisContextCatalog(invalid).map((issue) => issue.code)).toContain(
      "work_hub_source_provider_not_accessible",
    );
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

import { describe, expect, it } from "vite-plus/test";

import type {
  AxisContextCatalog,
  AxisContextProjectScope,
  AxisWorkHubSourceStatus,
} from "@t3tools/contracts";
import {
  AxisCapabilityId,
  AxisContextId,
  AxisWorkHubSourceId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { buildWorkHubProjectLinks, resolveProjectWorkHubIntegrations } from "./workHubProjectLinks";

const scope = {
  contextId: AxisContextId.make("company"),
  project: { environmentId: EnvironmentId.make("env-a"), projectId: ProjectId.make("project-a") },
} satisfies AxisContextProjectScope;

const catalog = (overrides: Partial<AxisContextCatalog> = {}): AxisContextCatalog =>
  ({
    contexts: [],
    projectBindings: [],
    providerOwnerships: [],
    providerAccessGrants: [],
    capabilities: [],
    workHubSources: [],
    ...overrides,
  }) as AxisContextCatalog;

describe("work hub project links", () => {
  it("only exposes destinations whose router contract supports the action", () => {
    const links = buildWorkHubProjectLinks(scope, "project-key");
    expect(links.configureProject).toEqual({
      kind: "link",
      to: "/projects/$projectKey",
      params: { projectKey: "project-key" },
      search: {
        view: "overview",
        environmentId: "env-a",
        projectId: "project-a",
      },
    });
    expect(links.configureSources.kind).toBe("unavailable");
    expect(links.configureSources).toMatchObject({
      reason: "Physical project selection is not supported by Work Hub source settings yet.",
    });
    expect(links.workHub.kind).toBe("unavailable");
  });

  it("requires an exact physical binding and does not match a homonym", () => {
    const result = resolveProjectWorkHubIntegrations({
      scope,
      catalog: catalog({
        projectBindings: [
          {
            contextId: scope.contextId,
            project: {
              environmentId: EnvironmentId.make("env-b"),
              projectId: scope.project.projectId,
            },
          },
        ],
      }),
    });
    expect(result.binding).toBeNull();
    expect(result.sources).toEqual([]);
  });

  it("filters sources by the bound context and joins existing statuses", () => {
    const source = {
      id: AxisWorkHubSourceId.make("source-a"),
      contextId: scope.contextId,
      provider: {
        environmentId: EnvironmentId.make("env-a"),
        instanceId: ProviderInstanceId.make("provider-a"),
      },
      capabilityId: AxisCapabilityId.make("cap-a"),
      enabled: true,
      cacheTtlSeconds: 28_800,
      collectionPolicy: { prompt: "" },
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
    };
    const status = {
      sourceId: source.id,
      status: "fresh",
      lastConfirmedSuccessAt: null,
      lastErrorAt: null,
      lastErrorKind: null,
      lastErrorMessage: null,
      snapshot: null,
    } as AxisWorkHubSourceStatus;
    const result = resolveProjectWorkHubIntegrations({
      scope,
      statuses: [status],
      catalog: catalog({
        projectBindings: [{ contextId: scope.contextId, project: scope.project }],
        capabilities: [
          {
            id: source.capabilityId,
            provider: source.provider,
            kind: "mcp",
            name: "Linear",
            enabled: true,
            compatibleDrivers: [],
            createdAt: source.createdAt,
            updatedAt: source.updatedAt,
          },
        ],
        workHubSources: [
          source,
          {
            ...source,
            id: AxisWorkHubSourceId.make("source-other"),
            contextId: AxisContextId.make("personal"),
          },
        ],
      }),
    });
    expect(result.binding).not.toBeNull();
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.status).toBe(status);
    expect(result.sources[0]?.capability?.name).toBe("Linear");
  });
});

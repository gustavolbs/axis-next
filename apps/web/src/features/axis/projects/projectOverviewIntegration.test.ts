import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  AxisContextId,
  EnvironmentId,
  ProjectId,
  type AxisContextCatalog,
  type AxisContextProjectScope,
} from "@t3tools/contracts";

import { PROJECT_OVERVIEW_VIEWS, parseProjectOverviewSearch } from "./projectOverviewRoute";

import { resolveScopeForSelectedProject } from "./projectOverviewIntegration";

const baseScope = (environmentId: string, projectId: string): AxisContextProjectScope => ({
  contextId: AxisContextId.make("ctx-A"),
  project: {
    environmentId: EnvironmentId.make(environmentId),
    projectId: ProjectId.make(projectId),
  },
});

const buildCatalog = (
  bindings: ReadonlyArray<{
    contextId: string;
    environmentId: string;
    projectId: string;
  }>,
): AxisContextCatalog => ({
  contexts: [
    {
      id: AxisContextId.make("ctx-A"),
      kind: "company" as const,
      name: "Company",
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    },
  ],
  projectBindings: bindings.map((binding) => ({
    contextId: AxisContextId.make(binding.contextId),
    project: {
      environmentId: EnvironmentId.make(binding.environmentId),
      projectId: ProjectId.make(binding.projectId),
    },
  })),
  providerOwnerships: [],
  providerAccessGrants: [],
  capabilities: [],
  workHubSources: [],
});

beforeEach(() => {
  // Each test owns its own catalog snapshot; no shared mock state required.
});

describe("projectOverviewIntegration", () => {
  it("accepts every view declared by the route table", () => {
    for (const view of PROJECT_OVERVIEW_VIEWS) {
      expect(parseProjectOverviewSearch({ view })).toEqual({ view });
    }
  });

  it("drops invalid physical member ids without inventing a selection", () => {
    expect(
      parseProjectOverviewSearch({
        view: "workflow",
        environmentId: " ",
        projectId: 3,
      }),
    ).toEqual({ view: "workflow" });
  });

  it("resolves the scope for the selected physical project from the live catalog", () => {
    const catalog = buildCatalog([
      { contextId: "ctx-A", environmentId: "remote", projectId: "site" },
      { contextId: "ctx-A", environmentId: "local", projectId: "site" },
    ]);
    const scope = resolveScopeForSelectedProject({
      catalog,
      selectedProject: {
        environmentId: EnvironmentId.make("remote"),
        projectId: ProjectId.make("site"),
      },
    });
    expect(scope?.project.environmentId).toBe("remote");
    expect(scope?.project.projectId).toBe("site");
    expect(scope?.contextId).toBe("ctx-A");
  });

  it("returns null when the catalog has not yet loaded", () => {
    const scope = resolveScopeForSelectedProject({
      catalog: null,
      selectedProject: {
        environmentId: EnvironmentId.make("remote"),
        projectId: ProjectId.make("site"),
      },
    });
    expect(scope).toBeNull();
  });

  it("returns null when no binding matches the selected project (out-of-order catalog response)", () => {
    const catalog = buildCatalog([
      { contextId: "ctx-A", environmentId: "local", projectId: "site" },
    ]);
    const scope = resolveScopeForSelectedProject({
      catalog,
      selectedProject: {
        environmentId: EnvironmentId.make("remote"),
        projectId: ProjectId.make("site"),
      },
    });
    expect(scope).toBeNull();
  });

  it("treats multiple bindings to the same project as a conflict (refuses to pick)", () => {
    const catalog = buildCatalog([
      { contextId: "ctx-A", environmentId: "remote", projectId: "site" },
      { contextId: "ctx-B", environmentId: "remote", projectId: "site" },
    ]);
    const scope = resolveScopeForSelectedProject({
      catalog,
      selectedProject: {
        environmentId: EnvironmentId.make("remote"),
        projectId: ProjectId.make("site"),
      },
    });
    expect(scope).toBeNull();
  });

  it("keeps the scope identity stable when the same scope is selected twice", () => {
    const catalog = buildCatalog([
      { contextId: "ctx-A", environmentId: "remote", projectId: "site" },
    ]);
    const selectedProject = {
      environmentId: EnvironmentId.make("remote"),
      projectId: ProjectId.make("site"),
    };
    const first = resolveScopeForSelectedProject({ catalog, selectedProject });
    const second = resolveScopeForSelectedProject({ catalog, selectedProject });
    expect(first).toEqual(second);
    expect(first?.contextId).toBe(baseScope("remote", "site").contextId);
  });

  it("returns null when no project is selected", () => {
    const catalog = buildCatalog([
      { contextId: "ctx-A", environmentId: "remote", projectId: "site" },
    ]);
    const scope = resolveScopeForSelectedProject({
      catalog,
      selectedProject: null,
    });
    expect(scope).toBeNull();
  });
});

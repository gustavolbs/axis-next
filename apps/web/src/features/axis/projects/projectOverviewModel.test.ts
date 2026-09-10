import { describe, expect, it } from "vite-plus/test";

import type { AxisContextProjectBinding, AxisProjectLocator } from "@t3tools/contracts";
import {
  EnvironmentId as EnvironmentIdSchema,
  ProjectId as ProjectIdSchema,
} from "@t3tools/contracts";
import type { ProjectGroup } from "../../../logicalProject";
import type { Project as EnvironmentProject } from "../../../types";
import { buildProjectOverviewModel } from "./projectOverviewModel";

const project = (environmentId: string, id: string, title: string): EnvironmentProject => ({
  environmentId: EnvironmentIdSchema.make(environmentId),
  id: ProjectIdSchema.make(id),
  title,
  workspaceRoot: `/workspace/${id}`,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
});

const group = (members: ReadonlyArray<EnvironmentProject>): ProjectGroup<EnvironmentProject> => ({
  key: "repo:axis",
  label: "Axis",
  representative: members[0]!,
  members: members.map((member) => ({
    physicalProjectKey: `${member.environmentId}:${member.workspaceRoot}`,
    project: member,
  })),
  memberProjectRefs: members.map(({ environmentId, id }) => ({ environmentId, projectId: id })),
});

const binding = (
  contextId: string,
  projectLocator: AxisProjectLocator,
): AxisContextProjectBinding => ({
  contextId: contextId as AxisContextProjectBinding["contextId"],
  project: projectLocator,
});

describe("project overview model", () => {
  it("keeps a mixed group executable on the explicitly selected remote member", () => {
    const local = project("local", "same-name", "Site");
    const remote = project("remote", "same-name", "Site");
    const model = buildProjectOverviewModel({
      groups: [group([local, remote])],
      selectedProjectRef: { environmentId: remote.environmentId, projectId: remote.id },
      contextId: "company" as AxisContextProjectBinding["contextId"],
      bindings: [
        binding("company", {
          environmentId: EnvironmentIdSchema.make("remote"),
          projectId: ProjectIdSchema.make("same-name"),
        }),
      ],
      connectionStates: new Map([
        [local.environmentId, "connected"],
        [remote.environmentId, "disconnected"],
      ]),
    });

    expect(model.groups[0]?.selectedMember?.project.environmentId).toBe("remote");
    expect(model.groups[0]?.members.map((member) => member.project.environmentId)).toEqual([
      "local",
      "remote",
    ]);
    expect(model.groups[0]?.selectedMember?.connectionState).toBe("disconnected");
    expect(model.selectedScope?.project.environmentId).toBe("remote");
    expect(model.groups[0]?.bindingState).toBe("bound");
  });

  it("requires a member choice when no physical project is selected", () => {
    const first = project("remote-a", "same-name", "Site");
    const second = project("remote-b", "same-name", "Site");
    const model = buildProjectOverviewModel({
      groups: [group([first, second])],
      selectedProjectRef: null,
      contextId: "company" as AxisContextProjectBinding["contextId"],
      bindings: [],
      connectionStates: new Map(),
    });

    expect(model.groups[0]?.selectionRequired).toBe(true);
    expect(model.groups[0]?.selectedMember).toBeNull();
    expect(model.selectedScope).toBeNull();
  });

  it("does not inherit a binding from another context", () => {
    const target = project("remote", "project", "Project");
    const model = buildProjectOverviewModel({
      groups: [group([target])],
      selectedProjectRef: { environmentId: target.environmentId, projectId: target.id },
      contextId: "company_b" as AxisContextProjectBinding["contextId"],
      bindings: [
        binding("company_a", {
          environmentId: target.environmentId,
          projectId: target.id,
        }),
      ],
      connectionStates: new Map([[target.environmentId, "connected"]]),
    });

    expect(model.groups[0]?.bindingState).toBe("unbound");
    expect(model.selectedScope).toBeNull();
  });

  it("surfaces ambiguous bindings instead of choosing a context implicitly", () => {
    const target = project("remote", "project", "Project");
    const locator: AxisProjectLocator = {
      environmentId: EnvironmentIdSchema.make("remote"),
      projectId: ProjectIdSchema.make("project"),
    };
    const model = buildProjectOverviewModel({
      groups: [group([target])],
      selectedProjectRef: {
        environmentId: EnvironmentIdSchema.make("remote"),
        projectId: ProjectIdSchema.make("project"),
      },
      contextId: null,
      bindings: [binding("personal", locator), binding("company", locator)],
      connectionStates: new Map([[target.environmentId, "connected"]]),
    });

    expect(model.groups[0]?.bindingState).toBe("ambiguous");
    expect(model.groups[0]?.bindingContextIds).toEqual(["personal", "company"]);
    expect(model.selectedScope).toBeNull();
  });

  it("produces a scope for a selected remote-only project without a primary environment", () => {
    const target = project("remote", "project", "Project");
    const model = buildProjectOverviewModel({
      groups: [group([target])],
      selectedProjectRef: { environmentId: target.environmentId, projectId: target.id },
      contextId: "company" as AxisContextProjectBinding["contextId"],
      bindings: [
        binding("company", {
          environmentId: target.environmentId,
          projectId: target.id,
        }),
      ],
      connectionStates: new Map([[target.environmentId, "connected"]]),
    });

    expect(model.groups[0]?.selectionRequired).toBe(false);
    expect(model.selectedScope).toEqual({
      contextId: "company",
      project: { environmentId: "remote", projectId: "project" },
    });
  });
});

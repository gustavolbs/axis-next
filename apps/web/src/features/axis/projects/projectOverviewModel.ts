import type {
  AxisContextId,
  AxisContextProjectBinding,
  AxisProjectLocator,
  EnvironmentConnectionState,
  EnvironmentId,
  ScopedProjectRef,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import type { ProjectGroup } from "../../../logicalProject";

export type AxisProjectOverviewMember = {
  readonly physicalProjectKey: string;
  readonly project: EnvironmentProject;
  readonly connectionState: EnvironmentConnectionState | "unknown";
  readonly isSelected: boolean;
};

export type AxisProjectOverviewBindingState = "unbound" | "bound" | "ambiguous";

export interface AxisProjectOverviewGroup {
  readonly key: string;
  readonly label: string;
  readonly members: ReadonlyArray<AxisProjectOverviewMember>;
  readonly selectedMember: AxisProjectOverviewMember | null;
  readonly selectionRequired: boolean;
  readonly bindingState: AxisProjectOverviewBindingState;
  readonly bindingContextIds: ReadonlyArray<AxisContextId>;
}

export interface AxisProjectOverviewModel {
  readonly groups: ReadonlyArray<AxisProjectOverviewGroup>;
  readonly selectedProjectRef: ScopedProjectRef | null;
  readonly selectedScope: {
    readonly contextId: AxisContextId;
    readonly project: AxisProjectLocator;
  } | null;
}

const projectRefMatches = (project: EnvironmentProject, ref: ScopedProjectRef | null): boolean =>
  ref !== null && project.environmentId === ref.environmentId && project.id === ref.projectId;

const projectLocatorMatches = (project: EnvironmentProject, locator: AxisProjectLocator): boolean =>
  project.environmentId === locator.environmentId && project.id === locator.projectId;

const bindingMatchesProject = (binding: AxisContextProjectBinding, project: EnvironmentProject) =>
  projectLocatorMatches(project, binding.project);

/**
 * Converts grouped projects into an execution-aware Overview model.
 * Grouping is presentation-only: selection and scope always point to a
 * concrete environment-owned project.
 */
export function buildProjectOverviewModel(input: {
  readonly groups: ReadonlyArray<ProjectGroup<EnvironmentProject>>;
  readonly selectedProjectRef: ScopedProjectRef | null;
  readonly contextId: AxisContextId | null;
  readonly bindings: ReadonlyArray<AxisContextProjectBinding>;
  readonly connectionStates: ReadonlyMap<EnvironmentId, EnvironmentConnectionState>;
}): AxisProjectOverviewModel {
  const selectedProject =
    input.groups
      .flatMap((group) => group.members.map((member) => member.project))
      .find((project) => projectRefMatches(project, input.selectedProjectRef)) ?? null;
  const groups = input.groups.map((group): AxisProjectOverviewGroup => {
    const selectedInGroup =
      group.members.find(({ project }) => project === selectedProject)?.project ?? null;

    const members: AxisProjectOverviewMember[] = group.members.map(
      ({ physicalProjectKey, project }) => ({
        physicalProjectKey,
        project,
        connectionState: input.connectionStates.get(project.environmentId) ?? "unknown",
        isSelected: selectedInGroup === project,
      }),
    );
    const matchingBindings = selectedInGroup
      ? input.bindings.filter((binding) => bindingMatchesProject(binding, selectedInGroup))
      : [];
    const contextBindings =
      input.contextId === null
        ? matchingBindings
        : matchingBindings.filter((binding) => binding.contextId === input.contextId);
    const bindingState: AxisProjectOverviewBindingState =
      contextBindings.length === 1
        ? "bound"
        : contextBindings.length > 1 || (input.contextId === null && matchingBindings.length > 1)
          ? "ambiguous"
          : "unbound";

    return {
      key: group.key,
      label: group.label,
      members,
      selectedMember: members.find((member) => member.isSelected) ?? null,
      selectionRequired: members.length > 1 && selectedInGroup === null,
      bindingState,
      bindingContextIds: matchingBindings.map((binding) => binding.contextId),
    };
  });

  const selectedGroup = groups.find((group) => group.selectedMember !== null) ?? null;
  const selectedScope =
    selectedProject !== null && input.contextId !== null && selectedGroup?.bindingState === "bound"
      ? {
          contextId: input.contextId,
          project: {
            environmentId: selectedProject.environmentId,
            projectId: selectedProject.id,
          },
        }
      : null;

  return {
    groups,
    selectedProjectRef:
      selectedProject === null
        ? null
        : { environmentId: selectedProject.environmentId, projectId: selectedProject.id },
    selectedScope,
  };
}

import type {
  AxisContextCatalog,
  AxisContextProjectScope,
  ScopedProjectRef,
} from "@t3tools/contracts";

export interface ResolveScopeForSelectedProjectInput {
  readonly catalog: AxisContextCatalog | null;
  readonly selectedProject: ScopedProjectRef | null;
}

function bindingMatchesProject(
  binding: AxisContextCatalog["projectBindings"][number],
  selectedProject: ScopedProjectRef,
): boolean {
  return (
    binding.project.environmentId === selectedProject.environmentId &&
    binding.project.projectId === selectedProject.projectId
  );
}

export function resolveScopeForSelectedProject(
  input: ResolveScopeForSelectedProjectInput,
): AxisContextProjectScope | null {
  if (input.catalog === null) return null;
  if (input.selectedProject === null) return null;
  const matching = input.catalog.projectBindings.filter((binding) =>
    bindingMatchesProject(binding, input.selectedProject as ScopedProjectRef),
  );
  if (matching.length !== 1) return null;
  const unique = matching[0]!;
  return {
    contextId: unique.contextId,
    project: {
      environmentId: unique.project.environmentId,
      projectId: unique.project.projectId,
    },
  };
}

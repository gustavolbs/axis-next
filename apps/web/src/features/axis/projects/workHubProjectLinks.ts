import type {
  AxisContextCatalog,
  AxisContextProjectBinding,
  AxisContextProjectScope,
  AxisCapability,
  AxisWorkHubSource,
  AxisWorkHubSourceStatus,
} from "@t3tools/contracts";

export type WorkHubProjectLink =
  | {
      readonly kind: "link";
      readonly to: "/settings/axis";
      readonly search: { readonly section: "projects" };
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface WorkHubProjectLinks {
  readonly configureProject: WorkHubProjectLink;
  readonly configureSources: WorkHubProjectLink;
  readonly workHub: WorkHubProjectLink;
}

export interface ProjectWorkHubIntegration {
  readonly source: AxisWorkHubSource;
  readonly capability: AxisCapability | null;
  readonly status: AxisWorkHubSourceStatus | null;
}

export interface ProjectWorkHubIntegrations {
  readonly binding: AxisContextProjectBinding | null;
  readonly sources: ReadonlyArray<ProjectWorkHubIntegration>;
}

export function buildWorkHubProjectLinks(scope: AxisContextProjectScope): WorkHubProjectLinks {
  void scope;
  return {
    configureProject: { kind: "link", to: "/settings/axis", search: { section: "projects" } },
    configureSources: {
      kind: "unavailable",
      reason: "Physical project selection is not supported by Work Hub source settings yet.",
    },
    workHub: {
      kind: "unavailable",
      reason: "Work Hub currently opens a global view without physical project scope.",
    },
  };
}

function isPhysicalBinding(binding: AxisContextProjectBinding, scope: AxisContextProjectScope) {
  return (
    binding.contextId === scope.contextId &&
    binding.project.environmentId === scope.project.environmentId &&
    binding.project.projectId === scope.project.projectId
  );
}

export function resolveProjectWorkHubIntegrations(input: {
  readonly catalog: AxisContextCatalog;
  readonly scope: AxisContextProjectScope;
  readonly statuses?: ReadonlyArray<AxisWorkHubSourceStatus>;
}): ProjectWorkHubIntegrations {
  const binding =
    input.catalog.projectBindings.find((candidate) => isPhysicalBinding(candidate, input.scope)) ??
    null;
  if (binding === null) return { binding: null, sources: [] };

  const capabilityById = new Map(
    input.catalog.capabilities.map((capability) => [capability.id, capability]),
  );
  const statusBySourceId = new Map(
    (input.statuses ?? []).map((status) => [status.sourceId, status]),
  );
  return {
    binding,
    sources: input.catalog.workHubSources
      .filter((source) => source.contextId === input.scope.contextId)
      .map((source) => ({
        source,
        capability: capabilityById.get(source.capabilityId) ?? null,
        status: statusBySourceId.get(source.id) ?? null,
      })),
  };
}

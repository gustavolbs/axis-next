import {
  axisProviderInstanceLocatorKey,
  type AxisContextCatalog,
  type AxisContextId,
  type AxisProjectLocator,
  type AxisProviderAccessGrantId,
  type AxisProviderInstanceLocator,
} from "@t3tools/contracts";

/** Removes one Company and every relationship that could retain access to it. */
export function removeAxisCompany(
  catalog: AxisContextCatalog,
  contextId: AxisContextId,
): AxisContextCatalog {
  const removedProviderKeys = new Set(
    catalog.providerOwnerships
      .filter((ownership) => ownership.contextId === contextId)
      .map((ownership) => axisProviderInstanceLocatorKey(ownership.provider)),
  );
  return {
    contexts: catalog.contexts.filter((context) => context.id !== contextId),
    projectBindings: catalog.projectBindings.filter((binding) => binding.contextId !== contextId),
    providerOwnerships: catalog.providerOwnerships.filter(
      (ownership) => ownership.contextId !== contextId,
    ),
    providerAccessGrants: catalog.providerAccessGrants.filter(
      (grant) =>
        grant.ownerContextId !== contextId &&
        grant.targetContextId !== contextId &&
        !removedProviderKeys.has(axisProviderInstanceLocatorKey(grant.provider)),
    ),
    capabilities: catalog.capabilities.filter(
      (capability) => !removedProviderKeys.has(axisProviderInstanceLocatorKey(capability.provider)),
    ),
    workHubSources: catalog.workHubSources.filter(
      (source) =>
        source.contextId !== contextId &&
        !removedProviderKeys.has(axisProviderInstanceLocatorKey(source.provider)),
    ),
  };
}

/** Assigns a T3 Project to exactly one Axis context, or removes its binding. */
export function setAxisProjectContext(
  catalog: AxisContextCatalog,
  project: AxisProjectLocator,
  contextId: AxisContextId | null,
): AxisContextCatalog {
  const matchesProject = (candidate: AxisProjectLocator) =>
    candidate.environmentId === project.environmentId && candidate.projectId === project.projectId;
  const current = catalog.projectBindings.find((binding) => matchesProject(binding.project));
  if (current?.contextId === contextId || (!current && contextId === null)) return catalog;
  return {
    ...catalog,
    projectBindings: [
      ...catalog.projectBindings.filter((binding) => !matchesProject(binding.project)),
      ...(contextId === null ? [] : [{ contextId, project }]),
    ],
  };
}

/** Reassigns a provider and removes grants that depended on its previous owner. */
export function setAxisProviderOwner(
  catalog: AxisContextCatalog,
  provider: AxisProviderInstanceLocator,
  contextId: AxisContextId | null,
): AxisContextCatalog {
  const providerKey = axisProviderInstanceLocatorKey(provider);
  const currentOwner = catalog.providerOwnerships.find(
    (ownership) => axisProviderInstanceLocatorKey(ownership.provider) === providerKey,
  )?.contextId;
  if (currentOwner === contextId || (currentOwner === undefined && contextId === null)) {
    return catalog;
  }
  const providerAccessGrants = catalog.providerAccessGrants.filter(
    (grant) => axisProviderInstanceLocatorKey(grant.provider) !== providerKey,
  );
  return {
    ...catalog,
    providerOwnerships: [
      ...catalog.providerOwnerships.filter(
        (ownership) => axisProviderInstanceLocatorKey(ownership.provider) !== providerKey,
      ),
      ...(contextId === null ? [] : [{ contextId, provider }]),
    ],
    providerAccessGrants,
    workHubSources: catalog.workHubSources.filter(
      (source) => axisProviderInstanceLocatorKey(source.provider) !== providerKey,
    ),
  };
}

/** Removes a Company's access to a Personal provider without changing that provider's capabilities. */
export function removeAxisProviderAccessGrant(
  catalog: AxisContextCatalog,
  grantId: AxisProviderAccessGrantId,
): AxisContextCatalog {
  const removed = catalog.providerAccessGrants.find((grant) => grant.id === grantId);
  if (!removed) return catalog;
  const providerKey = axisProviderInstanceLocatorKey(removed.provider);
  return {
    ...catalog,
    providerAccessGrants: catalog.providerAccessGrants.filter((grant) => grant.id !== grantId),
    workHubSources: catalog.workHubSources.filter(
      (source) =>
        source.contextId !== removed.targetContextId ||
        axisProviderInstanceLocatorKey(source.provider) !== providerKey,
    ),
  };
}

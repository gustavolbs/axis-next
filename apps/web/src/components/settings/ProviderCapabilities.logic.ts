import {
  axisProviderInstanceLocatorKey,
  type AxisCapabilityId,
  type AxisContextCatalog,
  type AxisProviderInstanceLocator,
} from "@t3tools/contracts";

/**
 * Changes only a capability owned by the selected provider. Keeping the
 * provider check here prevents a stale provider screen from mutating another
 * account's capability when a catalog refresh races with a user action.
 */
export function setAxisProviderCapabilityEnabled(input: {
  readonly catalog: AxisContextCatalog;
  readonly provider: AxisProviderInstanceLocator;
  readonly capabilityId: AxisCapabilityId;
  readonly enabled: boolean;
  readonly updatedAt: string;
}): AxisContextCatalog {
  const { catalog, provider, capabilityId, enabled, updatedAt } = input;
  const providerKey = axisProviderInstanceLocatorKey(provider);
  const capability = catalog.capabilities.find(
    (candidate) =>
      candidate.id === capabilityId &&
      axisProviderInstanceLocatorKey(candidate.provider) === providerKey,
  );
  if (!capability || capability.enabled === enabled) return catalog;

  return {
    ...catalog,
    capabilities: catalog.capabilities.map((candidate) =>
      candidate.id === capabilityId
        ? {
            ...candidate,
            enabled,
            updatedAt,
          }
        : candidate,
    ),
    // A disabled capability must not remain eligible for manual or scheduled
    // collection. Re-enabling it does not silently restore old selections.
    workHubSources: enabled
      ? catalog.workHubSources
      : catalog.workHubSources.map((source) =>
          source.capabilityId === capabilityId && source.enabled
            ? { ...source, enabled: false, updatedAt }
            : source,
        ),
  };
}

/**
 * Removes one provider-owned capability and all Work Hub bindings that depend
 * on it in the same catalog replacement.
 */
export function removeAxisProviderCapability(input: {
  readonly catalog: AxisContextCatalog;
  readonly provider: AxisProviderInstanceLocator;
  readonly capabilityId: AxisCapabilityId;
}): AxisContextCatalog {
  const { catalog, provider, capabilityId } = input;
  const providerKey = axisProviderInstanceLocatorKey(provider);
  const capability = catalog.capabilities.find(
    (candidate) =>
      candidate.id === capabilityId &&
      axisProviderInstanceLocatorKey(candidate.provider) === providerKey,
  );
  if (!capability) return catalog;

  return {
    ...catalog,
    capabilities: catalog.capabilities.filter((candidate) => candidate.id !== capabilityId),
    workHubSources: catalog.workHubSources.filter((source) => source.capabilityId !== capabilityId),
  };
}

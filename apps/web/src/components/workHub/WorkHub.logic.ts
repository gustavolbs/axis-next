import {
  axisProviderInstanceLocatorKey,
  resolveAxisContextProviderInstances,
  type AxisContextCatalog,
} from "@t3tools/contracts";

export function buildWorkHubSourceReadiness(catalog: AxisContextCatalog) {
  return catalog.contexts.map((context) => {
    const providers = resolveAxisContextProviderInstances(catalog, context.id);
    const providerKeys = new Set(providers.map(axisProviderInstanceLocatorKey));
    const availableMcps = catalog.capabilities.filter(
      (capability) =>
        capability.kind === "mcp" &&
        capability.enabled &&
        providerKeys.has(axisProviderInstanceLocatorKey(capability.provider)),
    );
    const availableMcpIds = new Set(availableMcps.map((capability) => capability.id));
    const selectedMcpCount = catalog.workHubSources.filter(
      (source) =>
        source.contextId === context.id &&
        source.enabled &&
        availableMcpIds.has(source.capabilityId),
    ).length;

    return {
      contextId: context.id,
      contextKind: context.kind,
      contextName: context.name,
      providerCount: providers.length,
      availableMcpCount: availableMcps.length,
      selectedMcpCount,
    } as const;
  });
}

export function buildWorkHubSourceGroups(catalog: AxisContextCatalog) {
  return catalog.contexts.map((context) => ({
    context,
    providers: resolveAxisContextProviderInstances(catalog, context.id).map((provider) => {
      const providerKey = axisProviderInstanceLocatorKey(provider);
      const mcps = catalog.capabilities.filter(
        (capability) =>
          capability.kind === "mcp" &&
          capability.enabled &&
          axisProviderInstanceLocatorKey(capability.provider) === providerKey,
      );
      const selectedCapabilityIds = new Set(
        catalog.workHubSources
          .filter(
            (source) =>
              source.contextId === context.id &&
              source.enabled &&
              axisProviderInstanceLocatorKey(source.provider) === providerKey,
          )
          .map((source) => source.capabilityId),
      );
      return { provider, mcps, selectedCapabilityIds } as const;
    }),
  }));
}

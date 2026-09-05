import {
  axisProviderInstanceLocatorKey,
  resolveAxisContextProviderInstances,
  type AxisContextCatalog,
} from "@t3tools/contracts";

export function buildWorkHubWeekDays(anchor: Date, weekOffset: number): ReadonlyArray<Date> {
  const start = new Date(anchor);
  start.setHours(0, 0, 0, 0);
  start.setDate(anchor.getDate() - ((anchor.getDay() + 6) % 7) + weekOffset * 7);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

export function workHubCurrentTimePercentage(now: Date): number {
  return ((now.getHours() * 60 + now.getMinutes()) / (24 * 60)) * 100;
}

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

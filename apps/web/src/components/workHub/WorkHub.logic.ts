import {
  axisProviderInstanceLocatorKey,
  resolveAxisContextProviderInstances,
  type AxisContextCatalog,
} from "@t3tools/contracts";

export function buildWorkHubSourceReadiness(catalog: AxisContextCatalog) {
  return catalog.contexts.map((context) => {
    const providers = resolveAxisContextProviderInstances(catalog, context.id);
    const providerKeys = new Set(providers.map(axisProviderInstanceLocatorKey));
    const mcpCount = catalog.capabilities.filter(
      (capability) =>
        capability.kind === "mcp" &&
        capability.enabled &&
        providerKeys.has(axisProviderInstanceLocatorKey(capability.provider)),
    ).length;

    return {
      contextId: context.id,
      contextKind: context.kind,
      contextName: context.name,
      providerCount: providers.length,
      mcpCount,
    } as const;
  });
}

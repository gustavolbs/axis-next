import { isProviderAvailable, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";

export function resolveStandaloneThreadTarget(
  configs: ReadonlyMap<EnvironmentId, ServerConfig>,
  preferredEnvironmentId: EnvironmentId | null,
) {
  const candidates =
    preferredEnvironmentId === null
      ? configs
      : new Map(
          [configs.get(preferredEnvironmentId)]
            .filter((config): config is ServerConfig => config !== undefined)
            .map((config) => [preferredEnvironmentId, config] as const),
        );

  for (const [environmentId, config] of candidates) {
    const provider = config.providers.find(
      (entry) => entry.enabled && entry.installed && isProviderAvailable(entry),
    );
    if (!provider) continue;
    return {
      environmentId,
      modelSelection: {
        instanceId: provider.instanceId,
        model:
          provider.models.find((model) => model.isDefault)?.slug ??
          provider.models[0]?.slug ??
          "auto",
      },
    } as const;
  }
  return null;
}

import { useMemo, useState } from "react";
import { RefreshCwIcon } from "lucide-react";

import {
  axisProviderInstanceLocatorKey,
  AXIS_WORK_HUB_DEFAULT_CACHE_TTL_SECONDS,
  DEFAULT_AXIS_WORK_HUB_COLLECTION_POLICY,
  AxisWorkHubSourceId,
  type AxisCapabilityId,
  type AxisContextCatalog,
  type AxisContextCatalogSnapshot,
  type AxisContextId,
  type AxisProviderInstanceLocator,
  type AxisWorkHubSource,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { cn, randomUUID } from "~/lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { buildWorkHubSourceGroups } from "./WorkHub.logic";

function contextTone(index: number): string {
  return ["bg-blue-500", "bg-violet-500", "bg-amber-500", "bg-emerald-500"][index % 4]!;
}

export function WorkHubSourceManager() {
  const environmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.axisContextCatalog({ environmentId, input: {} }),
  );
  const replaceCatalog = useAtomCommand(serverEnvironment.replaceAxisContextCatalog, {
    reportFailure: false,
  });
  const collectSource = useAtomCommand(serverEnvironment.collectProviderWorkHubSource, {
    reportFailure: false,
  });
  const replaceCache = useAtomCommand(serverEnvironment.replaceAxisWorkHubCache, {
    reportFailure: false,
  });
  const cacheQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.axisWorkHubCache({ environmentId, input: {} }),
  );
  const [saving, setSaving] = useState(false);
  const [syncingSourceId, setSyncingSourceId] = useState<string | null>(null);
  const providerLabels = useMemo(
    () =>
      new Map(
        environments.flatMap((environment) =>
          (environment.serverConfig?.providers ?? []).map(
            (provider) =>
              [
                axisProviderInstanceLocatorKey({
                  environmentId: environment.environmentId,
                  instanceId: provider.instanceId,
                }),
                `${provider.displayName ?? provider.instanceId} · ${environment.label}`,
              ] as const,
          ),
        ),
      ),
    [environments],
  );

  const save = async (snapshot: AxisContextCatalogSnapshot, catalog: AxisContextCatalog) => {
    if (environmentId === null || saving) return;
    setSaving(true);
    const result = await replaceCatalog({
      environmentId,
      input: { expectedRevision: snapshot.revision, catalog },
    });
    setSaving(false);
    if (result._tag === "Success") {
      query.refresh();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not update Work Hub sources",
        description: error instanceof Error ? error.message : "Reload and try again.",
      });
    }
  };

  const toggleMcp = (
    contextId: AxisContextId,
    capabilityId: AxisCapabilityId,
    selected: boolean,
  ) => {
    const snapshot = query.data;
    if (!snapshot) return;
    const capability = snapshot.catalog.capabilities.find(
      (candidate) => candidate.id === capabilityId,
    );
    if (!capability) return;
    const now = new Date().toISOString();
    const existing = snapshot.catalog.workHubSources.find(
      (source) => source.contextId === contextId && source.capabilityId === capabilityId,
    );
    void save(snapshot, {
      ...snapshot.catalog,
      workHubSources: selected
        ? existing
          ? snapshot.catalog.workHubSources.map((source) =>
              source.id === existing.id ? { ...source, enabled: true, updatedAt: now } : source,
            )
          : [
              ...snapshot.catalog.workHubSources,
              {
                id: AxisWorkHubSourceId.make(`work_hub_${randomUUID().replaceAll("-", "")}`),
                contextId,
                provider: capability.provider,
                capabilityId,
                enabled: true,
                cacheTtlSeconds: AXIS_WORK_HUB_DEFAULT_CACHE_TTL_SECONDS,
                collectionPolicy: DEFAULT_AXIS_WORK_HUB_COLLECTION_POLICY,
                createdAt: now,
                updatedAt: now,
              },
            ]
        : snapshot.catalog.workHubSources.filter(
            (source) => !(source.contextId === contextId && source.capabilityId === capabilityId),
          ),
    });
  };

  const toggleProvider = (
    contextId: AxisContextId,
    provider: AxisProviderInstanceLocator,
    capabilityIds: ReadonlyArray<AxisCapabilityId>,
    selected: boolean,
  ) => {
    const snapshot = query.data;
    if (!snapshot) return;
    const providerKey = axisProviderInstanceLocatorKey(provider);
    if (!selected) {
      void save(snapshot, {
        ...snapshot.catalog,
        workHubSources: snapshot.catalog.workHubSources.filter(
          (source) =>
            source.contextId !== contextId ||
            axisProviderInstanceLocatorKey(source.provider) !== providerKey,
        ),
      });
      return;
    }
    const now = new Date().toISOString();
    const existingCapabilityIds = new Set(
      snapshot.catalog.workHubSources
        .filter((source) => source.contextId === contextId)
        .map((source) => source.capabilityId),
    );
    void save(snapshot, {
      ...snapshot.catalog,
      workHubSources: [
        ...snapshot.catalog.workHubSources,
        ...capabilityIds
          .filter((capabilityId) => !existingCapabilityIds.has(capabilityId))
          .map((capabilityId) => ({
            id: AxisWorkHubSourceId.make(`work_hub_${randomUUID().replaceAll("-", "")}`),
            contextId,
            provider,
            capabilityId,
            enabled: true,
            cacheTtlSeconds: AXIS_WORK_HUB_DEFAULT_CACHE_TTL_SECONDS,
            collectionPolicy: DEFAULT_AXIS_WORK_HUB_COLLECTION_POLICY,
            createdAt: now,
            updatedAt: now,
          })),
      ],
    });
  };

  const syncMcp = async (source: AxisWorkHubSource, mcpName: string) => {
    if (environmentId === null || syncingSourceId !== null) return;
    setSyncingSourceId(source.id);
    const previous = cacheQuery.data?.find((snapshot) => snapshot.sourceId === source.id);
    const collected = await collectSource({
      environmentId: source.provider.environmentId,
      input: {
        sourceId: source.id,
        contextId: source.contextId,
        provider: source.provider,
        capabilityId: source.capabilityId,
        mcpName,
        collectionPolicy: source.collectionPolicy,
        cacheTtlSeconds: source.cacheTtlSeconds,
        previousCursor: previous?.cursor ?? null,
        previousRefreshedAt: previous?.refreshedAt ?? null,
      },
    });
    if (collected._tag !== "Success") {
      setSyncingSourceId(null);
      if (!isAtomCommandInterrupted(collected)) {
        const error = squashAtomCommandFailure(collected);
        toastManager.add({
          type: "error",
          title: `Could not sync ${mcpName}`,
          description: error instanceof Error ? error.message : "The provider sync failed.",
        });
      }
      return;
    }
    const stored = await replaceCache({
      environmentId,
      input: { snapshot: collected.value },
    });
    setSyncingSourceId(null);
    if (stored._tag === "Success") {
      cacheQuery.refresh();
      toastManager.add({
        type: "success",
        title: `${mcpName} synced`,
        description: `${stored.value.items.length} relevant item${stored.value.items.length === 1 ? "" : "s"} cached for ${source.cacheTtlSeconds / 3_600} hours.`,
      });
      return;
    }
    if (!isAtomCommandInterrupted(stored)) {
      const error = squashAtomCommandFailure(stored);
      toastManager.add({
        type: "error",
        title: `Could not cache ${mcpName} data`,
        description: error instanceof Error ? error.message : "The cache update failed.",
      });
    }
  };

  if (!query.data) return null;
  const catalog = query.data.catalog;
  const groups = buildWorkHubSourceGroups(catalog);
  return (
    <section className="rounded-2xl border border-border/70 bg-card/35 p-5 shadow-sm/5 xl:col-span-2">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-medium text-foreground">Work Hub sources</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose the providers and MCPs Work Hub may query inside each isolated context.
          </p>
        </div>
        <Badge variant="secondary">8 hour cache</Badge>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {groups.map((group, contextIndex) => (
          <div
            key={group.context.id}
            className="rounded-xl border border-border/65 bg-background/45"
          >
            <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
              <span className={cn("size-2.5 rounded-full", contextTone(contextIndex))} />
              <h3 className="text-sm font-medium text-foreground">{group.context.name}</h3>
              <Badge className="ml-auto" variant="outline">
                {group.context.kind === "personal" ? "Personal" : "Company"}
              </Badge>
            </div>
            {group.providers.length === 0 ? (
              <p className="px-4 py-5 text-sm text-muted-foreground">No providers available.</p>
            ) : (
              <div className="divide-y divide-border/60">
                {group.providers.map(({ provider, mcps, selectedCapabilityIds }) => {
                  const providerKey = axisProviderInstanceLocatorKey(provider);
                  const providerSelected =
                    mcps.length > 0 && mcps.every((mcp) => selectedCapabilityIds.has(mcp.id));
                  const providerLabel = providerLabels.get(providerKey) ?? provider.instanceId;
                  return (
                    <div key={providerKey} className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Switch
                          checked={providerSelected}
                          disabled={saving || syncingSourceId !== null || mcps.length === 0}
                          aria-label={`Use ${providerLabel} in ${group.context.name}`}
                          onCheckedChange={(selected) =>
                            toggleProvider(
                              group.context.id,
                              provider,
                              mcps.map((mcp) => mcp.id),
                              selected,
                            )
                          }
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-foreground">
                            {providerLabel}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {mcps.length} enabled MCP{mcps.length === 1 ? "" : "s"}
                          </p>
                        </div>
                      </div>
                      {mcps.length > 0 ? (
                        <div className="ml-8 mt-3 grid gap-2">
                          {mcps.map((mcp) => {
                            const source = catalog.workHubSources.find(
                              (candidate) =>
                                candidate.contextId === group.context.id &&
                                candidate.capabilityId === mcp.id,
                            );
                            const cached = source
                              ? cacheQuery.data?.find((snapshot) => snapshot.sourceId === source.id)
                              : undefined;
                            return (
                              <div
                                key={mcp.id}
                                className="flex items-center gap-2 text-sm text-muted-foreground"
                              >
                                <Switch
                                  checked={selectedCapabilityIds.has(mcp.id)}
                                  disabled={saving || syncingSourceId !== null}
                                  aria-label={`Use ${mcp.name} from ${providerLabel} in ${group.context.name}`}
                                  onCheckedChange={(selected) =>
                                    toggleMcp(group.context.id, mcp.id, selected)
                                  }
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate">{mcp.name}</span>
                                  {cached ? (
                                    <span className="block text-[11px] text-muted-foreground/80">
                                      Last synced {new Date(cached.refreshedAt).toLocaleString()}
                                    </span>
                                  ) : null}
                                </span>
                                {source?.enabled ? (
                                  <Button
                                    type="button"
                                    size="xs"
                                    variant="ghost-muted"
                                    className="shrink-0"
                                    disabled={syncingSourceId !== null}
                                    onClick={() => void syncMcp(source, mcp.name)}
                                  >
                                    <RefreshCwIcon
                                      className={
                                        syncingSourceId === source.id ? "animate-spin" : undefined
                                      }
                                    />
                                    {syncingSourceId === source.id ? "Syncing…" : "Sync"}
                                  </Button>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

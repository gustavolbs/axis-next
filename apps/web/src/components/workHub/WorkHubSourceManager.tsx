import { useMemo, useState, useSyncExternalStore } from "react";
import { RefreshCwIcon, Settings2Icon } from "lucide-react";

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
  type AxisWorkHubCollectionPolicy,
  type AxisWorkHubSource,
  type AxisWorkHubSourceStatus,
  isAxisWorkHubCacheFresh,
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
import { WorkHubSourceSettingsDialog } from "./WorkHubSourceSettingsDialog";

function contextTone(index: number): string {
  return ["bg-blue-500", "bg-violet-500", "bg-amber-500", "bg-emerald-500"][index % 4]!;
}

// Module-scoped so an in-flight sync keeps its "Syncing…" status when the user
// navigates away and back; component state would reset on every remount.
const syncingSources = new Set<string>();
let syncingSnapshot: ReadonlySet<string> = syncingSources;
const syncingListeners = new Set<() => void>();
function setSourceSyncing(sourceId: string, active: boolean) {
  if (active === syncingSources.has(sourceId)) return;
  if (active) syncingSources.add(sourceId);
  else syncingSources.delete(sourceId);
  syncingSnapshot = new Set(syncingSources);
  for (const listener of syncingListeners) listener();
}
function useSyncingSourceIds(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      syncingListeners.add(listener);
      return () => syncingListeners.delete(listener);
    },
    () => syncingSnapshot,
  );
}

export function WorkHubSourceManager() {
  const environmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [fallbackObservedAt] = useState(Date.now);
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
  const cacheQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.axisWorkHubCache({ environmentId, input: {} }),
  );
  const sourceStatusesQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.axisWorkHubSourceStatuses({ environmentId, input: {} }),
  );
  const [saving, setSaving] = useState(false);
  const [settingsSource, setSettingsSource] = useState<{
    readonly source: AxisWorkHubSource;
    readonly mcpName: string;
  } | null>(null);
  const syncingSourceIds = useSyncingSourceIds();
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

  const save = async (
    snapshot: AxisContextCatalogSnapshot,
    catalog: AxisContextCatalog,
  ): Promise<boolean> => {
    if (environmentId === null || saving) return false;
    setSaving(true);
    const result = await replaceCatalog({
      environmentId,
      input: { expectedRevision: snapshot.revision, catalog },
    });
    setSaving(false);
    if (result._tag === "Success") {
      query.refresh();
      sourceStatusesQuery.refresh();
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not update Work Hub sources",
        description: error instanceof Error ? error.message : "Reload and try again.",
      });
    }
    return false;
  };

  const updateSourceSettings = async (input: {
    readonly source: AxisWorkHubSource;
    readonly collectionPolicy: AxisWorkHubCollectionPolicy;
  }): Promise<boolean> => {
    const snapshot = query.data;
    if (!snapshot) return false;
    const updatedAt = new Date().toISOString();
    return save(snapshot, {
      ...snapshot.catalog,
      workHubSources: snapshot.catalog.workHubSources.map((source) =>
        source.id === input.source.id
          ? {
              ...source,
              collectionPolicy: input.collectionPolicy,
              updatedAt,
            }
          : source,
      ),
    });
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
    if (environmentId === null || syncingSources.has(source.id)) return;
    setSourceSyncing(source.id, true);
    try {
      await runSync(source, mcpName);
    } finally {
      setSourceSyncing(source.id, false);
    }
  };

  const runSync = async (source: AxisWorkHubSource, mcpName: string) => {
    const collected = await collectSource({
      environmentId: source.provider.environmentId,
      input: { sourceId: source.id },
    });
    if (collected._tag !== "Success") {
      if (isAtomCommandInterrupted(collected)) {
        // The server runs the sync detached and persists the result itself, so a
        // dropped request only loses this client's view of the outcome.
        toastManager.add({
          type: "info",
          title: `${mcpName} sync continues in the background`,
          description: "The result lands in the Work Hub cache when it finishes.",
        });
      } else {
        const error = squashAtomCommandFailure(collected);
        toastManager.add({
          type: "error",
          title: `Could not sync ${mcpName}`,
          description: error instanceof Error ? error.message : "The provider sync failed.",
        });
      }
      return;
    }
    // The server persists the merged snapshot before responding; the sync also
    // finishes and caches server-side even if this client navigates away mid-flight.
    cacheQuery.refresh();
    sourceStatusesQuery.refresh();
    toastManager.add({
      type: "success",
      title: `${mcpName} synced`,
      description: `${collected.value.items.length} relevant item${collected.value.items.length === 1 ? "" : "s"} cached for ${source.cacheTtlSeconds / 3_600} hours.`,
    });
  };

  if (!query.data) return null;
  const catalog = query.data.catalog;
  const groups = buildWorkHubSourceGroups(catalog);
  const sourceStatuses = new Map<string, AxisWorkHubSourceStatus>(
    (
      sourceStatusesQuery.data ??
      cacheQuery.data?.map((snapshot) => ({
        sourceId: snapshot.sourceId,
        status: isAxisWorkHubCacheFresh(snapshot, fallbackObservedAt)
          ? ("fresh" as const)
          : "stale",
        lastConfirmedSuccessAt: snapshot.refreshedAt,
        lastErrorAt: null,
        lastErrorKind: null,
        lastErrorMessage: null,
        snapshot,
      })) ??
      []
    ).map((status) => [status.sourceId, status] as const),
  );
  const availableSourceCount = groups.reduce(
    (total, group) =>
      total +
      group.providers.reduce((groupTotal, provider) => groupTotal + provider.mcps.length, 0),
    0,
  );
  const selectedSourceCount = groups.reduce(
    (total, group) =>
      total +
      group.providers.reduce(
        (providerTotal, provider) => providerTotal + provider.selectedCapabilityIds.size,
        0,
      ),
    0,
  );
  const attentionSourceCount = [...sourceStatuses.values()].filter(
    (status) => status.status === "error" || status.status === "authorization-required",
  ).length;
  return (
    <section className="border-y border-border/70 py-5 xl:col-span-2">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Work Hub setup
          </p>
          <h2 className="mt-1 text-base font-semibold text-foreground">Source selection</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose what Work Hub may query inside each isolated context. Every source uses its own
            prompt and cache.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">
            {selectedSourceCount} / {availableSourceCount} selected
          </Badge>
          {attentionSourceCount > 0 ? (
            <Badge variant="warning">{attentionSourceCount} need attention</Badge>
          ) : null}
        </div>
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
                  const selectedMcpCount = mcps.filter((mcp) =>
                    selectedCapabilityIds.has(mcp.id),
                  ).length;
                  const providerPartial = selectedMcpCount > 0 && !providerSelected;
                  const providerLabel = providerLabels.get(providerKey) ?? provider.instanceId;
                  const providerHasSyncingSource = mcps.some((mcp) => {
                    const source = catalog.workHubSources.find(
                      (candidate) =>
                        candidate.contextId === group.context.id &&
                        candidate.capabilityId === mcp.id,
                    );
                    return source !== undefined && syncingSourceIds.has(source.id);
                  });
                  return (
                    <div key={providerKey} className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Switch
                          checked={providerSelected}
                          aria-checked={providerPartial ? "mixed" : providerSelected}
                          className={providerPartial ? "bg-warning/70" : undefined}
                          disabled={saving || providerHasSyncingSource || mcps.length === 0}
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
                            {selectedMcpCount} of {mcps.length} MCP{mcps.length === 1 ? "" : "s"}{" "}
                            selected
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
                            const sourceStatus = source ? sourceStatuses.get(source.id) : undefined;
                            return (
                              <div
                                key={mcp.id}
                                className="flex items-center gap-2 text-sm text-muted-foreground"
                              >
                                <Switch
                                  checked={selectedCapabilityIds.has(mcp.id)}
                                  disabled={
                                    saving ||
                                    (source !== undefined && syncingSourceIds.has(source.id))
                                  }
                                  aria-label={`Use ${mcp.name} from ${providerLabel} in ${group.context.name}`}
                                  onCheckedChange={(selected) =>
                                    toggleMcp(group.context.id, mcp.id, selected)
                                  }
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate">{mcp.name}</span>
                                  {sourceStatus ? (
                                    <span className="block text-[11px] text-muted-foreground/80">
                                      {sourceStatus.status === "authorization-required"
                                        ? "Authorization required"
                                        : sourceStatus.status === "error"
                                          ? "Sync error"
                                          : sourceStatus.status === "fresh"
                                            ? "Fresh"
                                            : "Stale"}
                                      {sourceStatus.lastConfirmedSuccessAt
                                        ? ` · Last confirmed ${new Date(sourceStatus.lastConfirmedSuccessAt).toLocaleString()}`
                                        : " · No confirmed sync yet"}
                                      {sourceStatus.lastErrorMessage
                                        ? ` · ${sourceStatus.lastErrorMessage}`
                                        : ""}
                                    </span>
                                  ) : null}
                                </span>
                                {source?.enabled ? (
                                  <div className="flex shrink-0 items-center gap-1">
                                    <Button
                                      type="button"
                                      size="icon-xs"
                                      variant="ghost-muted"
                                      disabled={saving || syncingSourceIds.has(source.id)}
                                      aria-label={`Configure ${mcp.name} collection`}
                                      onClick={() =>
                                        setSettingsSource({ source, mcpName: mcp.name })
                                      }
                                    >
                                      <Settings2Icon />
                                    </Button>
                                    <Button
                                      type="button"
                                      size="xs"
                                      variant="ghost-muted"
                                      disabled={syncingSourceIds.has(source.id)}
                                      onClick={() => void syncMcp(source, mcp.name)}
                                    >
                                      <RefreshCwIcon
                                        className={
                                          syncingSourceIds.has(source.id)
                                            ? "animate-spin"
                                            : undefined
                                        }
                                      />
                                      {syncingSourceIds.has(source.id) ? "Syncing…" : "Sync"}
                                    </Button>
                                  </div>
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
      <WorkHubSourceSettingsDialog
        source={settingsSource?.source ?? null}
        mcpName={settingsSource?.mcpName ?? "MCP"}
        open={settingsSource !== null}
        saving={saving}
        onOpenChange={(open) => !open && setSettingsSource(null)}
        onSave={updateSourceSettings}
      />
    </section>
  );
}

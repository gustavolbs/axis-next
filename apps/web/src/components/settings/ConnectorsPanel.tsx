import {
  type EnvironmentId,
  type ProviderInstanceId,
  type ProviderMcpServer,
  type ServerProvider,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, LoaderIcon, SparklesIcon, WrenchIcon } from "lucide-react";

import { primaryServerProvidersAtom } from "../../state/server";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { usePrimaryEnvironment } from "../../state/environments";
import { Badge } from "../ui/badge";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

interface ConnectorScan {
  readonly key: string;
  readonly instanceId: ProviderInstanceId;
  readonly providerKind: ServerProvider["driver"];
  readonly displayName: string | undefined;
  readonly enabled: boolean;
  readonly loading: boolean;
  readonly error: unknown;
  readonly discoverySupported: boolean;
  readonly servers: ReadonlyArray<ProviderMcpServer>;
}

function driverLabel(provider: ServerProvider): string {
  return provider.displayName ?? provider.driver;
}

function statusVariant(status: ProviderMcpServer["status"]) {
  if (status === "connected" || status === "configured") return "success" as const;
  if (status === "failed") return "destructive" as const;
  if (status === "authentication-required") return "warning" as const;
  return "secondary" as const;
}

function statusLabel(status: ProviderMcpServer["status"]) {
  switch (status) {
    case "connected":
      return "Connected";
    case "configured":
      return "Configured";
    case "authentication-required":
      return "Needs auth";
    case "failed":
      return "Failed";
    case "pending-approval":
      return "Pending";
    case "disabled":
      return "Disabled";
  }
}

interface UnifiedConnectorRow {
  readonly key: string;
  readonly name: string;
  readonly target: string | undefined;
  readonly transport: string | undefined;
  readonly scope: string | undefined;
  readonly status: ProviderMcpServer["status"];
  readonly providerKind: ServerProvider["driver"];
  readonly providerLabel: string;
  readonly instanceId: ProviderInstanceId;
}

function useConnectorScans(
  environmentId: EnvironmentId | null,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ConnectorScan> {
  // Each scan is its own hook. Because the count is derived from the providers
  // list (a stable, reactive input), the React hook rule is satisfied: every
  // call site produces the same number of hook invocations on every render.
  const a = useProviderConnectorScan(environmentId, providers[0]);
  const b = useProviderConnectorScan(environmentId, providers[1]);
  const c = useProviderConnectorScan(environmentId, providers[2]);
  const d = useProviderConnectorScan(environmentId, providers[3]);
  const e = useProviderConnectorScan(environmentId, providers[4]);
  const f = useProviderConnectorScan(environmentId, providers[5]);
  const g = useProviderConnectorScan(environmentId, providers[6]);
  const h = useProviderConnectorScan(environmentId, providers[7]);
  return useMemo(() => {
    return [a, b, c, d, e, f, g, h].slice(0, providers.length);
  }, [providers, a, b, c, d, e, f, g, h]);
}

function useProviderConnectorScan(
  environmentId: EnvironmentId | null,
  instance: ServerProvider | undefined,
): ConnectorScan {
  const query = useEnvironmentQuery(
    environmentId && instance
      ? serverEnvironment.providerCapabilities({
          environmentId,
          input: { instanceId: instance.instanceId },
        })
      : null,
  );
  const data = query.data;
  return useMemo<ConnectorScan>(() => {
    if (!instance) {
      return {
        key: `${environmentId ?? "none"}:no-instance`,
        instanceId: "" as ProviderInstanceId,
        providerKind: "" as ServerProvider["driver"],
        displayName: undefined,
        enabled: false,
        loading: false,
        error: null,
        discoverySupported: true,
        servers: [],
      };
    }
    return {
      key: `${environmentId ?? ""}:${instance.instanceId}`,
      instanceId: instance.instanceId,
      providerKind: instance.driver,
      displayName: instance.displayName ?? undefined,
      enabled: instance.enabled && instance.installed,
      loading: query.isPending,
      error: query.error,
      discoverySupported: data?.mcpDiscoverySupported !== false,
      servers: data?.mcpServers ?? [],
    };
  }, [
    environmentId,
    instance,
    query.isPending,
    query.error,
    data?.mcpServers,
    data?.mcpDiscoverySupported,
  ]);
}

function ServerRow({ row }: { readonly row: UnifiedConnectorRow }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,8rem)_minmax(0,8rem)_minmax(0,9rem)_minmax(0,8rem)] items-center gap-3 border-b border-border/40 px-4 py-3 last:border-b-0">
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{row.name}</span>
        {row.target ? (
          <code className="block truncate text-[11px] text-muted-foreground">{row.target}</code>
        ) : null}
      </span>
      <span className="text-xs text-muted-foreground">{row.providerLabel}</span>
      <span className="text-xs text-muted-foreground">{row.transport ?? "native"}</span>
      <span className="text-xs text-muted-foreground">{row.scope ?? "local"}</span>
      <Badge variant={statusVariant(row.status)}>{statusLabel(row.status)}</Badge>
    </div>
  );
}

export function ConnectorsPanel() {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId: EnvironmentId | null = primaryEnvironment?.environmentId ?? null;

  const enabledProviders = useMemo(
    () => providers.filter((provider) => provider.enabled && provider.installed),
    [providers],
  );

  const scans = useConnectorScans(environmentId, enabledProviders);

  const unifiedRows = useMemo<ReadonlyArray<UnifiedConnectorRow>>(() => {
    const rows: UnifiedConnectorRow[] = [];
    scans.forEach((scan, index) => {
      const provider = enabledProviders[index]!;
      const providerLabel = driverLabel(provider);
      if (!scan.enabled || !scan.discoverySupported) return;
      if (scan.loading || scan.error) return;
      for (const server of scan.servers) {
        rows.push({
          key: `${scan.key}:${server.name}`,
          name: server.name,
          target: server.target ?? undefined,
          transport: server.transport ?? undefined,
          scope: server.scope ?? undefined,
          status: server.status,
          providerKind: provider.driver,
          providerLabel,
          instanceId: provider.instanceId,
        });
      }
    });
    return rows.toSorted((left, right) => {
      const byProvider = left.providerLabel.localeCompare(right.providerLabel);
      return byProvider !== 0 ? byProvider : left.name.localeCompare(right.name);
    });
  }, [scans, enabledProviders]);

  const noDiscovery = scans.filter(
    (scan) => scan.enabled && !scan.loading && !scan.error && scan.discoverySupported === false,
  );
  const loading = scans.some((scan) => scan.enabled && scan.loading);
  const totalCount = scans.reduce(
    (acc, scan) => (scan.enabled && scan.discoverySupported ? acc + scan.servers.length : acc),
    0,
  );

  return (
    <SettingsPageContainer width="wide" className="gap-6">
      <SettingsSection
        title="Connectors"
        description="Every MCP server discovered across every configured provider, gathered from their native config files."
      >
        <SettingsRow
          title="One panel, every provider"
          description={`${enabledProviders.length} provider${enabledProviders.length === 1 ? "" : "s"} reporting · ${totalCount} connector${totalCount === 1 ? "" : "s"} discovered.`}
          control={<SparklesIcon className="size-4 text-muted-foreground" aria-hidden />}
        />
      </SettingsSection>
      {loading ? (
        <SettingsSection title="Scanning providers">
          <SettingsRow
            title="Reading MCP catalogs"
            description="Querying every provider in parallel."
          >
            <LoaderIcon className="size-4 animate-spin text-muted-foreground" aria-hidden />
          </SettingsRow>
        </SettingsSection>
      ) : null}
      {unifiedRows.length > 0 ? (
        <SettingsSection
          title={`Discovered connectors (${unifiedRows.length})`}
          description="Every row maps to a connector exposed by its provider's native config (Claude, Codex, Cursor, OpenCode, Grok, …)."
        >
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,8rem)_minmax(0,8rem)_minmax(0,9rem)_minmax(0,8rem)] gap-3 px-4 py-2 text-xs font-medium text-muted-foreground lg:grid">
            <span>Connector</span>
            <span>Provider</span>
            <span>Type</span>
            <span>Scope</span>
            <span>Status</span>
          </div>
          <div className="divide-y divide-border/40">
            {unifiedRows.map((row) => (
              <ServerRow key={row.key} row={row} />
            ))}
          </div>
        </SettingsSection>
      ) : !loading ? (
        <SettingsRow
          title="No connectors found"
          description={
            enabledProviders.length === 0
              ? "Add a provider in Settings → Providers first."
              : "Every configured provider returned zero MCP servers."
          }
          control={<WrenchIcon className="size-4 text-muted-foreground" aria-hidden />}
        />
      ) : null}
      {noDiscovery.length > 0 ? (
        <SettingsSection
          title={`${noDiscovery.length} provider${noDiscovery.length === 1 ? "" : "s"} without MCP discovery`}
          description="These providers haven't been wired with native MCP discovery yet. Open them in their native settings to manage MCP servers."
        >
          {noDiscovery.map((scan) => (
            <SettingsRow
              key={scan.key}
              title={driverLabel({ driver: scan.providerKind } as ServerProvider)}
              description="Configure MCP servers in this provider's native settings; Axis will surface them here once discovery lands."
              status={<Badge variant="outline">No discovery</Badge>}
              control={
                <Link
                  to="/settings/providers"
                  search={{ instanceId: scan.instanceId, section: "general" }}
                  className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                >
                  Open
                  <ArrowRightIcon className="size-3.5" />
                </Link>
              }
            />
          ))}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

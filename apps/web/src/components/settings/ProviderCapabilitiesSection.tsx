import { useMemo, useState } from "react";
import { RefreshCwIcon, SearchIcon, Trash2Icon } from "lucide-react";
import {
  axisProviderInstanceLocatorKey,
  AxisCapabilityId,
  type AxisCapability,
  type AxisContextCatalog,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { randomUUID } from "~/lib/utils";
import { ensureLocalApi } from "~/localApi";
import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  removeAxisProviderCapability,
  setAxisProviderCapabilityEnabled,
} from "./ProviderCapabilities.logic";

type CapabilitySection = "mcps" | "skills" | "instructions" | "preferences";
type McpFilter = "all" | "connected" | "attention";
type SkillFilter = "all" | "enabled" | "disabled";

const MCP_STATUS_LABELS = {
  connected: "Connected",
  "authentication-required": "Authentication required",
  failed: "Connection failed",
  "pending-approval": "Pending approval",
  disabled: "Disabled",
  configured: "Configured",
} as const;

function EmptyCapabilityPage({ title, description }: { title: string; description: string }) {
  return (
    <SettingsSection title={title} description={description}>
      <SettingsRow
        title={`No ${title.toLowerCase()} discovered yet`}
        description="This area is isolated to the selected provider instance. Native discovery and editing will be added adapter by adapter."
      />
    </SettingsSection>
  );
}

export function ProviderCapabilitiesSection({
  environmentId,
  instanceId,
  section,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly section: CapabilitySection;
}) {
  const primaryEnvironment = usePrimaryEnvironment();
  const axisEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const axisSupported = primaryEnvironment?.serverConfig?.environment.capabilities.axis === true;
  const needsInventory = section === "mcps" || section === "skills";
  const query = useEnvironmentQuery(
    needsInventory
      ? serverEnvironment.providerCapabilities({ environmentId, input: { instanceId } })
      : null,
  );
  const axisQuery = useEnvironmentQuery(
    needsInventory && axisEnvironmentId !== null && axisSupported
      ? serverEnvironment.axisContextCatalog({ environmentId: axisEnvironmentId, input: {} })
      : null,
  );
  const replaceCatalog = useAtomCommand(serverEnvironment.replaceAxisContextCatalog, {
    reportFailure: false,
  });
  const [publishingMcp, setPublishingMcp] = useState<string | null>(null);
  const [savingCapabilityId, setSavingCapabilityId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [mcpFilter, setMcpFilter] = useState<McpFilter>("all");
  const [skillFilter, setSkillFilter] = useState<SkillFilter>("all");
  const inventory = query.data;
  const providerKey = axisProviderInstanceLocatorKey({ environmentId, instanceId });
  const providerIsAssigned =
    axisQuery.data?.catalog.providerOwnerships.some(
      (ownership) => axisProviderInstanceLocatorKey(ownership.provider) === providerKey,
    ) ?? false;
  const providerCapabilities =
    axisQuery.data?.catalog.capabilities.filter(
      (capability) => axisProviderInstanceLocatorKey(capability.provider) === providerKey,
    ) ?? [];
  const mcpCapabilitiesByName = new Map(
    providerCapabilities
      .filter((capability) => capability.kind === "mcp")
      .map((capability) => [capability.name, capability]),
  );
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleMcps = useMemo(
    () =>
      (inventory?.mcpServers ?? []).filter((server) => {
        const matchesSearch =
          normalizedSearch.length === 0 ||
          `${server.name} ${server.target ?? ""}`.toLocaleLowerCase().includes(normalizedSearch);
        const matchesFilter =
          mcpFilter === "all" ||
          (mcpFilter === "connected"
            ? server.status === "connected" || server.status === "configured"
            : server.status === "authentication-required" ||
              server.status === "failed" ||
              server.status === "pending-approval" ||
              server.status === "disabled");
        return matchesSearch && matchesFilter;
      }),
    [inventory, mcpFilter, normalizedSearch],
  );
  const visibleSkills = useMemo(
    () =>
      (inventory?.skills ?? []).filter((skill) => {
        const matchesSearch =
          normalizedSearch.length === 0 ||
          `${skill.displayName ?? skill.name} ${skill.description ?? ""}`
            .toLocaleLowerCase()
            .includes(normalizedSearch);
        const matchesFilter =
          skillFilter === "all" || (skillFilter === "enabled" ? skill.enabled : !skill.enabled);
        return matchesSearch && matchesFilter;
      }),
    [inventory, normalizedSearch, skillFilter],
  );

  const publishMcpToWorkHub = async (name: string, enabled: boolean) => {
    const snapshot = axisQuery.data;
    if (
      !snapshot ||
      axisEnvironmentId === null ||
      publishingMcp !== null ||
      savingCapabilityId !== null
    )
      return;
    const now = new Date().toISOString();
    setPublishingMcp(name);
    const result = await replaceCatalog({
      environmentId: axisEnvironmentId,
      input: {
        expectedRevision: snapshot.revision,
        catalog: {
          ...snapshot.catalog,
          capabilities: [
            ...snapshot.catalog.capabilities,
            {
              id: AxisCapabilityId.make(`capability_${randomUUID().replaceAll("-", "")}`),
              provider: { environmentId, instanceId },
              kind: "mcp",
              name,
              enabled,
              compatibleDrivers: [],
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
      },
    });
    setPublishingMcp(null);
    if (result._tag === "Success") {
      axisQuery.refresh();
      toastManager.add({
        type: "success",
        title: `${name} is available in Work Hub source settings`,
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: `Could not add ${name} to Work Hub`,
        description:
          error instanceof Error ? error.message : "Refresh Axis settings and try again.",
      });
    }
  };

  const saveCapabilityCatalog = async (
    capability: AxisCapability,
    catalog: AxisContextCatalog,
    successTitle: string,
  ) => {
    const snapshot = axisQuery.data;
    if (!snapshot || axisEnvironmentId === null || savingCapabilityId !== null) return;
    setSavingCapabilityId(capability.id);
    const result = await replaceCatalog({
      environmentId: axisEnvironmentId,
      input: { expectedRevision: snapshot.revision, catalog },
    });
    setSavingCapabilityId(null);
    if (result._tag === "Success") {
      axisQuery.refresh();
      toastManager.add({ type: "success", title: successTitle });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: `Could not update ${capability.name}`,
        description:
          error instanceof Error ? error.message : "Refresh Axis settings and try again.",
      });
    }
  };

  const toggleCapability = (capability: AxisCapability, enabled: boolean) => {
    const snapshot = axisQuery.data;
    if (!snapshot) return;
    const catalog = setAxisProviderCapabilityEnabled({
      catalog: snapshot.catalog,
      provider: { environmentId, instanceId },
      capabilityId: capability.id,
      enabled,
      updatedAt: new Date().toISOString(),
    });
    void saveCapabilityCatalog(
      capability,
      catalog,
      enabled ? `${capability.name} enabled` : `${capability.name} disabled`,
    );
  };

  const removeCapability = async (capability: AxisCapability) => {
    const snapshot = axisQuery.data;
    if (!snapshot) return;
    const bindingCount = snapshot.catalog.workHubSources.filter(
      (source) => source.capabilityId === capability.id,
    ).length;
    const bindingMessage =
      bindingCount === 0
        ? "It is not currently selected by any Work Hub context."
        : `This will also remove ${bindingCount} Work Hub source binding${bindingCount === 1 ? "" : "s"}.`;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Remove “${capability.name}” from Axis? ${bindingMessage} Its native provider configuration will not be changed.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    const catalog = removeAxisProviderCapability({
      catalog: snapshot.catalog,
      provider: { environmentId, instanceId },
      capabilityId: capability.id,
    });
    void saveCapabilityCatalog(capability, catalog, `${capability.name} removed`);
  };

  const capabilityControls = (capability: AxisCapability) => (
    <div className="flex items-center gap-2">
      <Switch
        checked={capability.enabled}
        disabled={savingCapabilityId !== null || publishingMcp !== null}
        aria-label={`Enable ${capability.name}`}
        onCheckedChange={(enabled) => toggleCapability(capability, enabled)}
      />
      <Button
        type="button"
        size="icon-sm"
        variant="ghost-muted"
        disabled={savingCapabilityId !== null || publishingMcp !== null}
        aria-label={`Remove ${capability.name}`}
        title="Remove from Axis"
        onClick={() => void removeCapability(capability)}
      >
        <Trash2Icon />
      </Button>
    </div>
  );

  if (section === "instructions") {
    return (
      <EmptyCapabilityPage
        title="Instructions"
        description="Provider-specific instructions, kept separate from every other provider and Company."
      />
    );
  }
  if (section === "preferences") {
    return (
      <EmptyCapabilityPage
        title="Preferences"
        description="Provider-native behavior and defaults for this specific account and home."
      />
    );
  }

  const isMcpPage = section === "mcps";
  const filters = isMcpPage
    ? (["all", "connected", "attention"] as const)
    : (["all", "enabled", "disabled"] as const);

  return (
    <SettingsSection
      title={isMcpPage ? "MCP connections" : "Skills"}
      description={
        isMcpPage
          ? "Connections discovered from this provider's native configuration. Secrets and command arguments are never returned to the client."
          : "Skills discovered in the scopes understood by this provider instance."
      }
      headerAction={
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={query.isPending}
          onClick={query.refresh}
        >
          <RefreshCwIcon className={query.isPending ? "animate-spin" : undefined} />
          Refresh
        </Button>
      }
    >
      <div className="grid gap-3 border-b border-border/60 p-3 sm:p-4">
        <div className="relative max-w-md">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={isMcpPage ? "Search MCP connections" : "Search skills"}
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {filters.map((filter) => (
            <Button
              key={filter}
              type="button"
              size="xs"
              variant={
                (isMcpPage ? mcpFilter : skillFilter) === filter ? "secondary" : "ghost-muted"
              }
              onClick={() =>
                isMcpPage
                  ? setMcpFilter(filter as McpFilter)
                  : setSkillFilter(filter as SkillFilter)
              }
            >
              {filter === "all"
                ? "All"
                : filter === "attention"
                  ? "Needs attention"
                  : filter[0]!.toUpperCase() + filter.slice(1)}
            </Button>
          ))}
        </div>
      </div>

      {query.error ? (
        <SettingsRow
          title={`Could not inspect ${isMcpPage ? "MCP connections" : "skills"}`}
          description={query.error}
          control={<Button onClick={query.refresh}>Retry</Button>}
        />
      ) : null}
      {!query.error && query.isPending && !inventory ? (
        <SettingsRow title="Inspecting provider" description="Reading native configuration…" />
      ) : null}

      {inventory && isMcpPage ? (
        !inventory.mcpDiscoverySupported ? (
          <SettingsRow
            title="Native MCP discovery is not available"
            description="This adapter will gain its own connector implementation in a later pass."
          />
        ) : visibleMcps.length === 0 ? (
          <SettingsRow
            title={inventory.mcpServers.length === 0 ? "No MCP connections found" : "No matches"}
            description="Add connections with the provider's native tooling, then refresh."
          />
        ) : (
          <div className="divide-y divide-border/50">
            <div className="hidden grid-cols-[minmax(12rem,1fr)_8rem_9rem_11rem_auto] gap-3 px-4 py-2 text-xs font-medium text-muted-foreground lg:grid">
              <span>Connector</span>
              <span>Type</span>
              <span>Scope</span>
              <span>Status</span>
              <span>Axis</span>
            </div>
            {visibleMcps.map((server) => {
              const capability = mcpCapabilitiesByName.get(server.name);
              return (
                <div
                  key={`${server.scope ?? "provider"}:${server.name}`}
                  className="grid items-center gap-2 px-3 py-3 lg:grid-cols-[minmax(12rem,1fr)_8rem_9rem_11rem_auto] lg:gap-3 lg:px-4"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{server.name}</span>
                    {server.target ? (
                      <code className="block truncate text-[11px] text-muted-foreground">
                        {server.target}
                      </code>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {server.transport ?? "Native"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {server.scope ?? "Provider"}
                  </span>
                  <Badge
                    variant={server.status === "failed" ? "destructive" : "secondary"}
                    className="w-fit"
                  >
                    {MCP_STATUS_LABELS[server.status]}
                  </Badge>
                  {capability ? (
                    capabilityControls(capability)
                  ) : (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={
                        !axisSupported ||
                        !providerIsAssigned ||
                        publishingMcp !== null ||
                        savingCapabilityId !== null
                      }
                      title={
                        !axisSupported
                          ? "Update the primary environment to enable Axis."
                          : providerIsAssigned
                            ? undefined
                            : "Assign this provider in Axis first."
                      }
                      onClick={() => void publishMcpToWorkHub(server.name, server.enabled)}
                    >
                      {publishingMcp === server.name ? "Adding…" : "Add"}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )
      ) : null}

      {inventory && !isMcpPage ? (
        visibleSkills.length === 0 ? (
          <SettingsRow
            title={inventory.skills.length === 0 ? "No skills found" : "No matches"}
            description="Skills are read from this provider's native user and project scopes."
          />
        ) : (
          <div className="divide-y divide-border/50">
            {visibleSkills.map((skill) => {
              const capability = providerCapabilities.find(
                (candidate) =>
                  candidate.kind === "skill" &&
                  (candidate.name === skill.name || candidate.name === skill.displayName),
              );
              return (
                <SettingsRow
                  key={skill.path}
                  title={skill.displayName ?? skill.name}
                  description={skill.shortDescription ?? skill.description ?? skill.path}
                  status={skill.scope ?? "Provider"}
                  control={
                    capability ? (
                      capabilityControls(capability)
                    ) : (
                      <Badge variant={skill.enabled ? "success" : "outline"}>
                        {skill.enabled ? "Native enabled" : "Native disabled"}
                      </Badge>
                    )
                  }
                />
              );
            })}
          </div>
        )
      ) : null}
    </SettingsSection>
  );
}

import { useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import {
  axisProviderInstanceLocatorKey,
  AxisCapabilityId,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { randomUUID } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const MCP_STATUS_LABELS = {
  connected: "Connected",
  "authentication-required": "Authentication required",
  failed: "Connection failed",
  "pending-approval": "Pending approval",
  disabled: "Disabled",
  configured: "Configured",
} as const;

export function ProviderCapabilitiesSection({
  environmentId,
  instanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}) {
  const axisEnvironmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    serverEnvironment.providerCapabilities({ environmentId, input: { instanceId } }),
  );
  const axisQuery = useEnvironmentQuery(
    axisEnvironmentId === null
      ? null
      : serverEnvironment.axisContextCatalog({ environmentId: axisEnvironmentId, input: {} }),
  );
  const replaceCatalog = useAtomCommand(serverEnvironment.replaceAxisContextCatalog, {
    reportFailure: false,
  });
  const [publishingMcp, setPublishingMcp] = useState<string | null>(null);
  const inventory = query.data;
  const providerKey = axisProviderInstanceLocatorKey({ environmentId, instanceId });
  const providerIsAssigned =
    axisQuery.data?.catalog.providerOwnerships.some(
      (ownership) => axisProviderInstanceLocatorKey(ownership.provider) === providerKey,
    ) ?? false;
  const workHubMcpNames = new Set(
    axisQuery.data?.catalog.capabilities
      .filter(
        (capability) =>
          capability.kind === "mcp" &&
          axisProviderInstanceLocatorKey(capability.provider) === providerKey,
      )
      .map((capability) => capability.name) ?? [],
  );

  const publishMcpToWorkHub = async (name: string, enabled: boolean) => {
    const snapshot = axisQuery.data;
    if (!snapshot || axisEnvironmentId === null || publishingMcp !== null) return;
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

  return (
    <SettingsSection
      title="Capabilities"
      description="MCPs and skills discovered from this provider instance. Nothing is copied between providers."
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
      {query.error ? (
        <SettingsRow
          title="Could not inspect capabilities"
          description={query.error}
          control={
            <Button type="button" size="xs" variant="outline" onClick={query.refresh}>
              Retry
            </Button>
          }
        />
      ) : null}

      {!query.error && query.isPending && !inventory ? (
        <SettingsRow title="Inspecting provider" description="Reading its native configuration…" />
      ) : null}

      {inventory ? (
        <>
          <div className="border-b border-border/60 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:px-4">
            MCP connections · {inventory.mcpServers.length}
          </div>
          {!inventory.mcpDiscoverySupported ? (
            <SettingsRow
              title="Native MCP discovery is not available"
              description="This provider adapter does not expose its MCP configuration yet."
            />
          ) : inventory.mcpServers.length === 0 ? (
            <SettingsRow
              title="No MCP connections found"
              description="Add one with the provider CLI, then refresh this inventory."
            />
          ) : (
            inventory.mcpServers.map((server) => (
              <SettingsRow
                key={`${server.scope ?? "provider"}:${server.name}`}
                title={server.name}
                description={
                  <span className="grid gap-0.5">
                    {server.target ? (
                      <code className="line-clamp-1 text-[11px] text-muted-foreground">
                        {server.target}
                      </code>
                    ) : null}
                    {server.detail ? <span className="line-clamp-2">{server.detail}</span> : null}
                  </span>
                }
                control={
                  <span className="flex items-center gap-1.5">
                    {server.scope ? <Badge variant="outline">{server.scope}</Badge> : null}
                    <Badge variant={server.status === "failed" ? "destructive" : "secondary"}>
                      {MCP_STATUS_LABELS[server.status]}
                    </Badge>
                    {workHubMcpNames.has(server.name) ? (
                      <Badge variant="success">Work Hub</Badge>
                    ) : (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={!providerIsAssigned || publishingMcp !== null}
                        title={
                          providerIsAssigned
                            ? undefined
                            : "Assign this provider to Personal or a Company in Axis first."
                        }
                        onClick={() => void publishMcpToWorkHub(server.name, server.enabled)}
                      >
                        {publishingMcp === server.name ? "Adding…" : "Add to Work Hub"}
                      </Button>
                    )}
                  </span>
                }
              />
            ))
          )}

          <div className="border-y border-border/60 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:px-4">
            Skills · {inventory.skills.length}
          </div>
          {inventory.skills.length === 0 ? (
            <SettingsRow
              title="No skills found"
              description="Skills are read from the directories and scopes understood by this provider."
            />
          ) : (
            inventory.skills.map((skill) => (
              <SettingsRow
                key={skill.path}
                title={skill.displayName ?? skill.name}
                description={skill.shortDescription ?? skill.description ?? skill.path}
                control={
                  <span className="flex items-center gap-1.5">
                    {skill.scope ? <Badge variant="outline">{skill.scope}</Badge> : null}
                    <Badge variant={skill.enabled ? "secondary" : "outline"}>
                      {skill.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </span>
                }
              />
            ))
          )}

          <div className="border-t border-border/60">
            <SettingsRow
              title="Instructions and preferences"
              description="These remain isolated in this provider instance's native home and environment configuration."
            />
          </div>
        </>
      ) : null}
    </SettingsSection>
  );
}

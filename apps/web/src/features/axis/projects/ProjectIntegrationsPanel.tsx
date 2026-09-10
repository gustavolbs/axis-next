import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";

import type {
  AxisContextProjectScope,
  EnvironmentConnectionState,
  EnvironmentId,
} from "@t3tools/contracts";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import {
  buildWorkHubProjectLinks,
  resolveProjectWorkHubIntegrations,
  type WorkHubProjectLink,
} from "./workHubProjectLinks";

type ProjectIntegrationsConnectionState = EnvironmentConnectionState | "unauthorized";

function statusLabel(status: string): string {
  switch (status) {
    case "fresh":
      return "Fresh";
    case "stale":
      return "Stale";
    case "error":
      return "Sync error";
    case "authorization-required":
      return "Authorization required";
    default:
      return status;
  }
}

function LinkButton({
  link,
  children,
}: {
  readonly link: WorkHubProjectLink;
  readonly children: string;
}) {
  if (link.kind === "unavailable") {
    return (
      <Button
        size="xs"
        variant="outline"
        disabled
        title={link.reason}
        aria-label={`${children} unavailable: ${link.reason}`}
      >
        {children} unavailable
      </Button>
    );
  }
  return (
    <Button size="xs" variant="outline" render={<Link to={link.to} search={link.search} />}>
      <ExternalLinkIcon aria-hidden />
      {children}
    </Button>
  );
}

export function ProjectIntegrationsPanel({
  environmentId,
  scope,
  projectLabel,
  connectionState,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: AxisContextProjectScope;
  readonly projectLabel?: string;
  readonly connectionState: ProjectIntegrationsConnectionState;
}) {
  const links = buildWorkHubProjectLinks(scope);
  const scopeMatchesEnvironment = scope.project.environmentId === environmentId;
  const catalogQuery = useEnvironmentQuery(
    scopeMatchesEnvironment && connectionState === "connected"
      ? serverEnvironment.axisContextCatalog({ environmentId, input: {} })
      : null,
  );
  const statusesQuery = useEnvironmentQuery(
    scopeMatchesEnvironment && connectionState === "connected"
      ? serverEnvironment.axisWorkHubSourceStatuses({ environmentId, input: {} })
      : null,
  );

  if (!scopeMatchesEnvironment) {
    return (
      <SettingsSection title="Integrations">
        <SettingsRow
          title="Project environment mismatch"
          description="The selected physical project belongs to another environment."
        />
      </SettingsSection>
    );
  }
  if (connectionState !== "connected") {
    return (
      <SettingsSection title="Integrations">
        <SettingsRow
          title="Environment disconnected"
          description="Connect this environment to inspect its Work Hub integrations."
        />
      </SettingsSection>
    );
  }
  if (catalogQuery.isPending && catalogQuery.data === null) {
    return (
      <SettingsSection title="Integrations">
        <SettingsRow title="Loading integrations" />
      </SettingsSection>
    );
  }
  if (catalogQuery.error !== null) {
    return (
      <SettingsSection title="Integrations">
        <SettingsRow
          title="Could not load integrations"
          description={catalogQuery.error}
          control={
            <Button size="xs" variant="outline" onClick={catalogQuery.refresh}>
              <RefreshCwIcon aria-hidden />
              Refresh
            </Button>
          }
        />
      </SettingsSection>
    );
  }
  if (catalogQuery.data === null) return null;
  if (statusesQuery.isPending && statusesQuery.data === null) {
    return (
      <SettingsSection title="Integrations">
        <SettingsRow title="Loading integration status" />
      </SettingsSection>
    );
  }
  if (statusesQuery.error !== null) {
    return (
      <SettingsSection title="Integrations">
        <SettingsRow
          title="Could not load integration status"
          description={statusesQuery.error}
          control={
            <Button size="xs" variant="outline" onClick={statusesQuery.refresh}>
              <RefreshCwIcon aria-hidden />
              Refresh
            </Button>
          }
        />
      </SettingsSection>
    );
  }

  const model = resolveProjectWorkHubIntegrations({
    catalog: catalogQuery.data.catalog,
    scope,
    statuses: statusesQuery.data ?? [],
  });
  return (
    <SettingsSection
      title="Integrations"
      description={projectLabel === undefined ? undefined : `Physical project: ${projectLabel}`}
    >
      {model.binding === null ? (
        <SettingsRow
          title="No project association"
          description="No explicit Axis context binding exists for this physical project. Open the global project bindings settings to select it there."
          control={
            <LinkButton link={links.configureProject}>Open project bindings settings</LinkButton>
          }
        />
      ) : model.sources.length === 0 ? (
        <SettingsRow
          title="No Work Hub sources configured"
          description="The project is associated with this context, but no Work Hub source is configured."
          control={<LinkButton link={links.configureSources}>Configure sources</LinkButton>}
        />
      ) : (
        <>
          {model.sources.map(({ source, capability, status }) => (
            <SettingsRow
              key={source.id}
              title={capability?.name ?? source.capabilityId}
              description={`Context ${source.contextId} · provider ${source.provider.instanceId}`}
              status={
                <Badge
                  variant={
                    source.enabled
                      ? status?.status === "error"
                        ? "error"
                        : "outline"
                      : "secondary"
                  }
                >
                  {!source.enabled
                    ? "Disabled"
                    : status === null
                      ? "No sync status"
                      : statusLabel(status.status)}
                </Badge>
              }
            />
          ))}
          <div className="flex flex-wrap gap-2 px-4 py-3">
            <LinkButton link={links.configureSources}>Manage sources</LinkButton>
            <LinkButton link={links.workHub}>Open Work Hub</LinkButton>
          </div>
        </>
      )}
    </SettingsSection>
  );
}

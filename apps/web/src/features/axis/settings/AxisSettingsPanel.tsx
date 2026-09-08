/**
 * The Axis settings route.
 *
 * One screen is visible at a time, chosen by the `section` search param — the
 * same shape `/settings/providers` already uses. Previously all six concerns
 * were stacked in one scroll with only three of them reachable from the
 * sidebar, which is what made the page hard to navigate: the reader had to
 * hold "which of these lists am I looking at" in their head.
 *
 * @module features/axis/settings/AxisSettingsPanel
 */
import { RefreshCwIcon, SparklesIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import { AxisLearningSettings } from "./AxisLearningSettings";
import {
  AXIS_SETTINGS_SCREENS,
  DEFAULT_AXIS_SETTINGS_SECTION,
  type AxisSettingsSection,
} from "./axisSettingsNav";
import { CapabilitiesSection } from "./sections/CapabilitiesSection";
import { ContextsSection } from "./sections/ContextsSection";
import { GrantsSection } from "./sections/GrantsSection";
import { ProjectsSection } from "./sections/ProjectsSection";
import { ProvidersSection } from "./sections/ProvidersSection";
import { useAxisSettings, type AxisSettingsLoaded } from "./useAxisSettings";

function AxisSummary({ model, section }: { model: AxisSettingsLoaded; section: string }) {
  const { catalog } = model.snapshot;
  const activeCapabilities = catalog.capabilities.filter((capability) => capability.enabled).length;
  const selectedSources = catalog.workHubSources.filter((source) => source.enabled).length;
  const activeGrants = catalog.providerAccessGrants.filter(
    (grant) => grant.status === "active",
  ).length;
  const metrics = [
    { label: "Contexts", value: catalog.contexts.length, detail: "Personal and Company" },
    { label: "Providers", value: catalog.providerOwnerships.length, detail: "Assigned to Axis" },
    { label: "Capabilities", value: activeCapabilities, detail: "Enabled for agents" },
    { label: "Work Hub sources", value: selectedSources, detail: `${activeGrants} active grants` },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
            <SparklesIcon className="size-3.5 text-primary" />
            Axis control plane
          </div>
          <h1 className="mt-2 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            {section}
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Keep contexts, provider access, and agent capabilities understandable at a glance.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="success">Axis ready</Badge>
          <Button
            size="xs"
            variant="outline"
            disabled={model.query.isPending}
            onClick={model.query.refresh}
          >
            <RefreshCwIcon className={model.query.isPending ? "animate-spin" : undefined} />
            Refresh
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 divide-x divide-border/60 border-y border-border/60 py-1 sm:grid-cols-4">
        {metrics.map((metric) => (
          <div key={metric.label} className="min-w-0 px-3 py-3 first:pl-0 sm:px-4 sm:first:pl-0">
            <p className="text-xl font-semibold tabular-nums text-foreground">{metric.value}</p>
            <p className="mt-0.5 truncate text-xs font-medium text-foreground/80">{metric.label}</p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{metric.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AxisSettingsPanel({ section }: { readonly section?: AxisSettingsSection }) {
  const model = useAxisSettings();
  const active = section ?? DEFAULT_AXIS_SETTINGS_SECTION;
  const screen = AXIS_SETTINGS_SCREENS.find((entry) => entry.section === active);

  if (model.environmentId === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Axis" description="Connect a primary environment to manage Axis.">
          <SettingsRow title="No primary environment" />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  if (!model.snapshot) {
    const isConnected = model.primaryEnvironment?.connection.phase === "connected";
    const needsUpdate =
      isConnected && model.primaryEnvironment?.serverConfig !== null && !model.axisSupported;
    return (
      <SettingsPageContainer>
        <SettingsSection title="Axis" description="Contexts, providers, MCPs, and skills.">
          <SettingsRow
            title={
              needsUpdate
                ? "Axis requires a backend update"
                : !isConnected
                  ? "Primary environment is offline"
                  : model.query.error
                    ? "Could not load Axis settings"
                    : "Loading Axis settings"
            }
            description={
              needsUpdate
                ? "Update or restart the primary environment with an Axis-enabled build. Retrying this older backend cannot load Axis."
                : !isConnected
                  ? "Reconnect the primary environment to load its Axis catalog."
                  : model.query.error
                    ? "The Axis request failed after the environment connected. Retry the request."
                    : undefined
            }
            status={model.query.error ?? undefined}
            control={
              !isConnected ? (
                <Button disabled={model.reconnecting} onClick={() => void model.reconnect()}>
                  {model.reconnecting ? "Reconnecting…" : "Reconnect"}
                </Button>
              ) : model.query.error ? (
                <Button onClick={model.query.refresh}>Retry request</Button>
              ) : undefined
            }
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  // Both narrowings are established above; the screens take the loaded shape
  // so none of them re-checks for a snapshot it cannot render without.
  const loaded = model as AxisSettingsLoaded;

  return (
    <SettingsPageContainer width="wide" className="gap-7">
      <AxisSummary model={loaded} section={screen?.label ?? "Axis settings"} />
      {active === "contexts" ? <ContextsSection model={loaded} /> : null}
      {active === "projects" ? <ProjectsSection model={loaded} /> : null}
      {active === "providers" ? <ProvidersSection model={loaded} /> : null}
      {active === "capabilities" ? <CapabilitiesSection model={loaded} /> : null}
      {active === "grants" ? <GrantsSection model={loaded} /> : null}
      {active === "learning" ? (
        <AxisLearningSettings
          environmentId={loaded.environmentId}
          contexts={loaded.snapshot.catalog.contexts}
        />
      ) : null}
      {screen === undefined ? (
        <SettingsSection title="Axis" description="Unknown Axis settings screen.">
          <SettingsRow title="Pick a screen from the sidebar" />
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

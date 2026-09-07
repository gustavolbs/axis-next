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
    <SettingsPageContainer>
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

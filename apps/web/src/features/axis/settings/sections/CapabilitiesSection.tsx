import { Link } from "@tanstack/react-router";
import { CheckIcon, Trash2Icon } from "lucide-react";

import type { AxisCapability, AxisCapabilityKind } from "@t3tools/contracts";

import { ensureLocalApi } from "~/localApi";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import {
  removeAxisProviderCapability,
  setAxisProviderCapabilityEnabled,
} from "~/components/settings/ProviderCapabilities.logic";
import type { AxisSettingsLoaded } from "../useAxisSettings";

const CAPABILITY_LABELS: Readonly<Record<AxisCapabilityKind, string>> = {
  mcp: "MCP",
  skill: "Skill",
  instructions: "Instructions",
  preferences: "Preferences",
};

export function CapabilitiesSection({ model }: { readonly model: AxisSettingsLoaded }) {
  const { snapshot, saving, save, providers, providerLabel } = model;

  const toggleCapability = (capability: AxisCapability, enabled: boolean) => {
    void save(
      snapshot,
      setAxisProviderCapabilityEnabled({
        catalog: snapshot.catalog,
        provider: capability.provider,
        capabilityId: capability.id,
        enabled,
        updatedAt: new Date().toISOString(),
      }),
      enabled ? "Capability enabled" : "Capability disabled",
    );
  };

  const removeCapability = async (capability: AxisCapability) => {
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
    void save(
      snapshot,
      removeAxisProviderCapability({
        catalog: snapshot.catalog,
        provider: capability.provider,
        capabilityId: capability.id,
      }),
      "Capability removed",
    );
  };

  return (
    <>
      <SettingsSection
        id="axis-capabilities"
        title="Adopted capabilities"
        description="MCPs and skills Axis has adopted. Disabling one here stops Axis using it; removing one leaves the provider's own configuration untouched."
      >
        {snapshot.catalog.capabilities.length === 0 ? (
          <SettingsRow
            title="No capabilities adopted yet"
            description="Discovered MCPs stay on their provider until Axis adopts them. Open a provider below to see what it offers."
          />
        ) : (
          snapshot.catalog.capabilities.map((capability) => (
            <SettingsRow
              key={capability.id}
              title={capability.name}
              description={`${CAPABILITY_LABELS[capability.kind]} · ${providerLabel(capability.provider)}`}
              status={
                <Badge variant={capability.enabled ? "success" : "outline"}>
                  {capability.enabled ? <CheckIcon /> : null}
                  {capability.enabled ? "Enabled" : "Disabled"}
                </Badge>
              }
              control={
                <div className="flex items-center gap-2">
                  <Switch
                    checked={capability.enabled}
                    disabled={saving}
                    aria-label={`Enable ${capability.name}`}
                    onCheckedChange={(enabled) => toggleCapability(capability, enabled)}
                  />
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    disabled={saving}
                    aria-label={`Remove ${capability.name}`}
                    title="Remove from Axis"
                    onClick={() => void removeCapability(capability)}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              }
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection
        title="Where capabilities come from"
        description="MCPs, skills, instructions, and preferences belong to a provider instance. Open one to inspect or change its native configuration."
      >
        {providers.map((provider) => (
          <SettingsRow
            key={provider.key}
            title={provider.label}
            description="Manage this provider's isolated MCP connections and skills."
            control={
              <Button
                render={
                  <Link
                    to="/settings/providers"
                    search={{
                      environmentId: provider.locator.environmentId,
                      instanceId: provider.locator.instanceId,
                      section: "mcps",
                    }}
                  />
                }
                size="xs"
                variant="outline"
              >
                Manage
              </Button>
            }
          />
        ))}
      </SettingsSection>
    </>
  );
}

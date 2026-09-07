import { axisProviderInstanceLocatorKey, AxisContextId } from "@t3tools/contracts";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { setAxisProviderOwner } from "../AxisSettings.logic";
import type { AxisSettingsLoaded } from "../useAxisSettings";

export function ProvidersSection({ model }: { readonly model: AxisSettingsLoaded }) {
  const { snapshot, saving, save, providers, providerOwnerByKey, contextNames } = model;

  return (
    <SettingsSection
      id="axis-provider-ownership"
      title="Provider ownership"
      description="Assign every configured provider account to Personal or exactly one Company. A provider with adopted capabilities cannot go back to unassigned."
    >
      {providers.length === 0 ? (
        <SettingsRow
          title="No providers found"
          description="Configure a provider connection before assigning its Axis owner."
        />
      ) : (
        providers.map((provider) => {
          const owner = providerOwnerByKey.get(provider.key);
          const hasCapabilities = snapshot.catalog.capabilities.some(
            (capability) => axisProviderInstanceLocatorKey(capability.provider) === provider.key,
          );
          return (
            <SettingsRow
              key={provider.key}
              title={provider.label}
              status={owner ? (contextNames.get(owner) ?? owner) : "Unassigned"}
              control={
                <Select
                  value={owner ?? "unassigned"}
                  disabled={saving}
                  onValueChange={(value) => {
                    if (value === null) return;
                    void save(
                      snapshot,
                      setAxisProviderOwner(
                        snapshot.catalog,
                        provider.locator,
                        value === "unassigned" ? null : AxisContextId.make(value),
                      ),
                      "Provider owner updated",
                    );
                  }}
                >
                  <SelectTrigger className="w-44" aria-label={`Owner of ${provider.label}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="unassigned" disabled={hasCapabilities}>
                      Unassigned
                    </SelectItem>
                    {snapshot.catalog.contexts.map((context) => (
                      <SelectItem key={context.id} value={context.id}>
                        {context.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          );
        })
      )}
    </SettingsSection>
  );
}

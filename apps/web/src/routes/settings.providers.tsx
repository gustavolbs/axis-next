import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";

const PROVIDER_SECTIONS = ["general", "mcps", "skills", "instructions", "preferences"] as const;

function SettingsProvidersRoute() {
  const target = Route.useSearch();
  return <ProviderSettingsPanel {...target} />;
}

export const Route = createFileRoute("/settings/providers")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
    ...(typeof raw.section === "string" &&
    PROVIDER_SECTIONS.includes(raw.section as (typeof PROVIDER_SECTIONS)[number])
      ? { section: raw.section as (typeof PROVIDER_SECTIONS)[number] }
      : {}),
  }),
  component: SettingsProvidersRoute,
});

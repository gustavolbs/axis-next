import { createFileRoute } from "@tanstack/react-router";

import { AxisSettingsPanel } from "~/features/axis/settings/AxisSettingsPanel";
import { isAxisSettingsSection } from "~/features/axis/settings/axisSettingsNav";

function SettingsAxisRoute() {
  return <AxisSettingsPanel {...Route.useSearch()} />;
}

export const Route = createFileRoute("/settings/axis")({
  validateSearch: (raw: Record<string, unknown>) =>
    isAxisSettingsSection(raw.section) ? { section: raw.section } : {},
  component: SettingsAxisRoute,
});

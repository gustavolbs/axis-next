import { createFileRoute } from "@tanstack/react-router";

import { ConnectorsPanel } from "../components/settings/ConnectorsPanel";

function SettingsConnectorsRoute() {
  return <ConnectorsPanel />;
}

export const Route = createFileRoute("/settings/connectors")({
  component: SettingsConnectorsRoute,
});

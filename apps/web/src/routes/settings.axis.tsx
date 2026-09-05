import { createFileRoute } from "@tanstack/react-router";

import { AxisSettingsPanel } from "../components/settings/AxisSettings";

export const Route = createFileRoute("/settings/axis")({
  component: AxisSettingsPanel,
});

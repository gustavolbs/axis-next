import { createFileRoute } from "@tanstack/react-router";

import { WorkHubPage } from "../components/workHub/WorkHubPage";

export const Route = createFileRoute("/work-hub")({
  component: WorkHubPage,
});

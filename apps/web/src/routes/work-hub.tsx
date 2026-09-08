import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { WorkHubPage } from "../components/workHub/WorkHubPage";
import { isWorkHubView } from "../components/workHub/WorkHub.logic";

function WorkHubRoute() {
  const navigate = useNavigate({ from: "/work-hub" });
  const { view } = Route.useSearch();
  return (
    <WorkHubPage
      view={view}
      onViewChange={(nextView) => {
        void navigate({ search: { view: nextView }, replace: true });
      }}
    />
  );
}

export const Route = createFileRoute("/work-hub")({
  validateSearch: (raw: Record<string, unknown>) =>
    isWorkHubView(raw.view) ? { view: raw.view } : {},
  component: WorkHubRoute,
});

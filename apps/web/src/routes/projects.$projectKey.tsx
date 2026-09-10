import { createFileRoute, redirect } from "@tanstack/react-router";

import { ProjectSettingsPage } from "../components/settings/ProjectSettingsPanel";
import { ProjectOverviewPage } from "../features/axis/projects/ProjectOverviewPage";
import {
  parseProjectOverviewSearch,
  type ProjectOverviewView,
} from "../features/axis/projects/projectOverviewRoute";

export const Route = createFileRoute("/projects/$projectKey")({
  validateSearch: (raw: Record<string, unknown>) => parseProjectOverviewSearch(raw),
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: () => {
    const { projectKey } = Route.useParams();
    const search = Route.useSearch();
    const view: ProjectOverviewView = search.view ?? "overview";
    if (view === "settings") return <ProjectSettingsPage projectKey={projectKey} />;
    return (
      <ProjectOverviewPage
        projectKey={projectKey}
        view={view}
        {...(search.environmentId === undefined
          ? {}
          : { selectedEnvironmentId: search.environmentId })}
        {...(search.projectId === undefined ? {} : { selectedProjectId: search.projectId })}
      />
    );
  },
});

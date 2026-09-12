import { AxisContextId } from "@t3tools/contracts";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { setAxisProjectContext } from "../AxisSettings.logic";
import type { AxisSettingsLoaded } from "../useAxisSettings";

export function ProjectsSection({ model }: { readonly model: AxisSettingsLoaded }) {
  const { snapshot, saving, save, environmentId, localProjects, projectContextById, contextNames } =
    model;

  return (
    <SettingsSection
      id="axis-project-contexts"
      title="Project contexts"
      description="For one project, choose the context directly in its Overview. This list remains available for bulk administration."
    >
      {localProjects.length === 0 ? (
        <SettingsRow
          title="No Projects found"
          description="Add a Project to this environment before assigning its Axis context."
        />
      ) : (
        localProjects.map((project) => {
          const contextId = projectContextById.get(project.id);
          return (
            <SettingsRow
              key={project.id}
              title={project.title}
              description={project.workspaceRoot}
              status={contextId ? (contextNames.get(contextId) ?? contextId) : "Unassigned"}
              control={
                <Select
                  value={contextId ?? "unassigned"}
                  disabled={saving}
                  onValueChange={(value) => {
                    if (value === null) return;
                    void save(
                      snapshot,
                      setAxisProjectContext(
                        snapshot.catalog,
                        { environmentId, projectId: project.id },
                        value === "unassigned" ? null : AxisContextId.make(value),
                      ),
                      "Project context updated",
                    );
                  }}
                >
                  <SelectTrigger className="w-44" aria-label={`Context of ${project.title}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
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

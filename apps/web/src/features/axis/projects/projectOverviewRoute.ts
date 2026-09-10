export const PROJECT_OVERVIEW_VIEWS = [
  "overview",
  "settings",
  "patterns",
  "workflow",
  "integrations",
  "learning",
] as const;

export type ProjectOverviewView = (typeof PROJECT_OVERVIEW_VIEWS)[number];

export function isProjectOverviewView(value: unknown): value is ProjectOverviewView {
  return typeof value === "string" && PROJECT_OVERVIEW_VIEWS.includes(value as ProjectOverviewView);
}

export interface ProjectOverviewSearch {
  readonly view?: ProjectOverviewView;
  readonly environmentId?: string;
  readonly projectId?: string;
}

export function parseProjectOverviewSearch(raw: Record<string, unknown>): ProjectOverviewSearch {
  return {
    ...(isProjectOverviewView(raw.view) ? { view: raw.view } : {}),
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim().length > 0
      ? { environmentId: raw.environmentId }
      : {}),
    ...(typeof raw.projectId === "string" && raw.projectId.trim().length > 0
      ? { projectId: raw.projectId }
      : {}),
  };
}

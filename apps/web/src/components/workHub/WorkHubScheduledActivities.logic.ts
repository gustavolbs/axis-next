import {
  resolveAxisContextProviderInstances,
  type AxisContextCatalog,
  type AxisContextId,
  type EnvironmentId,
} from "@t3tools/contracts";

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

type ScheduledActivitySchedule =
  | {
      readonly kind: "interval";
      readonly everyMinutes: number;
      readonly anchorAt: string;
    }
  | {
      readonly kind: "weekly";
      readonly daysOfWeek: ReadonlyArray<number>;
      readonly localTime: string;
      readonly timezone: string;
    };

export function formatScheduledActivitySchedule(schedule: ScheduledActivitySchedule): string {
  if (schedule.kind === "interval") {
    if (schedule.everyMinutes % (24 * 60) === 0) {
      const days = schedule.everyMinutes / (24 * 60);
      return `Every ${days} day${days === 1 ? "" : "s"}`;
    }
    if (schedule.everyMinutes % 60 === 0) {
      const hours = schedule.everyMinutes / 60;
      return `Every ${hours} hour${hours === 1 ? "" : "s"}`;
    }
    return `Every ${schedule.everyMinutes} minutes`;
  }

  const days = [...schedule.daysOfWeek]
    .sort((left, right) => left - right)
    .map((day) => WEEKDAY_LABELS[day])
    .filter((day): day is (typeof WEEKDAY_LABELS)[number] => day !== undefined)
    .join(", ");
  return `${days || "No days"} at ${schedule.localTime} (${schedule.timezone})`;
}

export function validateScheduledActivityForm(input: {
  readonly name: string;
  readonly actionKind: "workHubSync" | "agentTurn";
  readonly sourceIds: ReadonlyArray<string>;
  readonly projectId: string;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly threadTitle: string;
  readonly prompt: string;
  readonly availableProjectIds: ReadonlyArray<string>;
  readonly availableProviderInstanceIds: ReadonlyArray<string>;
  readonly scheduleKind: "interval" | "weekly";
  readonly everyHours: number;
  readonly daysOfWeek: ReadonlyArray<number>;
  readonly localTime: string;
  readonly timezone: string;
}): string | null {
  if (input.name.trim().length === 0) return "Enter a name for this activity.";
  if (input.actionKind === "workHubSync") {
    if (input.sourceIds.length === 0) return "Select at least one Work Hub source.";
  } else {
    if (!input.projectId) return "Select a Project assigned to this context.";
    if (!input.availableProjectIds.includes(input.projectId)) {
      return "The selected Project is no longer assigned to this context.";
    }
    if (!input.providerInstanceId) return "Select a provider available to this context.";
    if (!input.availableProviderInstanceIds.includes(input.providerInstanceId)) {
      return "The selected provider is no longer available to this context.";
    }
    if (!input.model.trim()) return "Enter the model used for this activity.";
    if (!input.threadTitle.trim()) return "Enter a title for the created Thread.";
    if (!input.prompt.trim()) return "Enter the instructions for the scheduled agent.";
  }
  if (input.scheduleKind === "interval") {
    if (!Number.isInteger(input.everyHours) || input.everyHours < 1) {
      return "Interval must be at least one whole hour.";
    }
    return null;
  }
  if (input.daysOfWeek.length === 0) return "Select at least one day of the week.";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.localTime)) return "Enter a valid local time.";
  if (input.timezone.trim().length === 0) return "Enter a timezone.";
  return null;
}

export function resolveScheduledAgentTargets(input: {
  readonly catalog: AxisContextCatalog;
  readonly contextId: AxisContextId;
  readonly environmentId: EnvironmentId;
}) {
  return {
    projects: input.catalog.projectBindings
      .filter(
        (binding) =>
          binding.contextId === input.contextId &&
          binding.project.environmentId === input.environmentId,
      )
      .map((binding) => binding.project),
    providers: resolveAxisContextProviderInstances(input.catalog, input.contextId).filter(
      (provider) => provider.environmentId === input.environmentId,
    ),
  };
}

export function sourceSelectionBelongsToContext(
  sourceIds: ReadonlyArray<string>,
  contextSourceIds: ReadonlyArray<string>,
): boolean {
  const allowed = new Set(contextSourceIds);
  return sourceIds.length > 0 && sourceIds.every((sourceId) => allowed.has(sourceId));
}

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
  readonly sourceIds: ReadonlyArray<string>;
  readonly scheduleKind: "interval" | "weekly";
  readonly everyHours: number;
  readonly daysOfWeek: ReadonlyArray<number>;
  readonly localTime: string;
  readonly timezone: string;
}): string | null {
  if (input.name.trim().length === 0) return "Enter a name for this activity.";
  if (input.sourceIds.length === 0) return "Select at least one Work Hub source.";
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

export function sourceSelectionBelongsToContext(
  sourceIds: ReadonlyArray<string>,
  contextSourceIds: ReadonlyArray<string>,
): boolean {
  const allowed = new Set(contextSourceIds);
  return sourceIds.length > 0 && sourceIds.every((sourceId) => allowed.has(sourceId));
}

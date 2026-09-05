import { describe, expect, it } from "vite-plus/test";

import {
  formatScheduledActivitySchedule,
  sourceSelectionBelongsToContext,
  validateScheduledActivityForm,
} from "./WorkHubScheduledActivities.logic";

describe("formatScheduledActivitySchedule", () => {
  it("uses readable units for intervals", () => {
    expect(
      formatScheduledActivitySchedule({
        kind: "interval",
        everyMinutes: 480,
        anchorAt: "2026-09-05T12:00:00.000Z",
      }),
    ).toBe("Every 8 hours");
    expect(
      formatScheduledActivitySchedule({
        kind: "interval",
        everyMinutes: 2_880,
        anchorAt: "2026-09-05T12:00:00.000Z",
      }),
    ).toBe("Every 2 days");
  });

  it("sorts and labels weekly schedules", () => {
    expect(
      formatScheduledActivitySchedule({
        kind: "weekly",
        daysOfWeek: [5, 1, 3],
        localTime: "09:30",
        timezone: "America/Fortaleza",
      }),
    ).toBe("Mon, Wed, Fri at 09:30 (America/Fortaleza)");
  });
});

describe("validateScheduledActivityForm", () => {
  const valid = {
    name: "Morning sync",
    sourceIds: ["source_a"],
    scheduleKind: "interval" as const,
    everyHours: 8,
    daysOfWeek: [] as ReadonlyArray<number>,
    localTime: "09:00",
    timezone: "America/Fortaleza",
  };

  it("requires a name and at least one source", () => {
    expect(validateScheduledActivityForm({ ...valid, name: " " })).toBe(
      "Enter a name for this activity.",
    );
    expect(validateScheduledActivityForm({ ...valid, sourceIds: [] })).toBe(
      "Select at least one Work Hub source.",
    );
  });

  it("validates interval and weekly schedules", () => {
    expect(validateScheduledActivityForm({ ...valid, everyHours: 0 })).toBe(
      "Interval must be at least one whole hour.",
    );
    expect(
      validateScheduledActivityForm({ ...valid, scheduleKind: "weekly", daysOfWeek: [] }),
    ).toBe("Select at least one day of the week.");
    expect(
      validateScheduledActivityForm({
        ...valid,
        scheduleKind: "weekly",
        daysOfWeek: [1],
        localTime: "25:00",
      }),
    ).toBe("Enter a valid local time.");
  });
});

describe("sourceSelectionBelongsToContext", () => {
  it("only accepts non-empty selections fully owned by the context", () => {
    expect(sourceSelectionBelongsToContext(["a", "b"], ["a", "b", "c"])).toBe(true);
    expect(sourceSelectionBelongsToContext(["a", "elsewhere"], ["a", "b"])).toBe(false);
    expect(sourceSelectionBelongsToContext([], ["a"])).toBe(false);
  });
});

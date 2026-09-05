import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AxisScheduledActivityDraft,
  AxisScheduledActivityListRunsInput,
  AxisScheduledActivityRun,
} from "./axisScheduledActivity.ts";

const decodeDraft = Schema.decodeUnknownSync(AxisScheduledActivityDraft);
const decodeRun = Schema.decodeUnknownSync(AxisScheduledActivityRun);
const decodeListRunsInput = Schema.decodeUnknownSync(AxisScheduledActivityListRunsInput);

describe("AxisScheduledActivity", () => {
  it("decodes an interval Work Hub sync draft", () => {
    const draft = decodeDraft({
      id: "morning_sync",
      name: "Morning sync",
      contextId: "personal",
      action: { kind: "workHubSync", sourceIds: ["calendar"] },
      schedule: {
        kind: "interval",
        everyMinutes: 480,
        anchorAt: "2026-09-05T08:00:00.000Z",
      },
    });

    expect(draft.enabled).toBe(true);
    expect(draft.action.sourceIds).toEqual(["calendar"]);
  });

  it("rejects empty source lists and invalid weekly times", () => {
    expect(() =>
      decodeDraft({
        id: "invalid",
        name: "Invalid",
        contextId: "personal",
        action: { kind: "workHubSync", sourceIds: [] },
        schedule: { kind: "weekly", daysOfWeek: [1], localTime: "25:00", timezone: "UTC" },
      }),
    ).toThrow();
  });

  it("decodes partial run history with per-source outcomes", () => {
    const run = decodeRun({
      id: "run_1",
      activityId: "morning_sync",
      trigger: "scheduled",
      status: "partial",
      startedAt: "2026-09-05T08:00:00.000Z",
      finishedAt: "2026-09-05T08:01:00.000Z",
      message: "1 source synced; 1 failed or skipped.",
      sourceResults: [
        { sourceId: "calendar", status: "succeeded", itemCount: 4, message: null },
        { sourceId: "jira", status: "failed", itemCount: 0, message: "offline" },
      ],
    });

    expect(run.sourceResults.map((result) => result.status)).toEqual(["succeeded", "failed"]);
  });

  it("caps requested run history to a defensive maximum", () => {
    expect(decodeListRunsInput({ activityId: "morning_sync" }).limit).toBe(20);
    expect(() => decodeListRunsInput({ activityId: "morning_sync", limit: 101 })).toThrow();
  });
});

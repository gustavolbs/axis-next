/** Axis scheduled activities and their execution history. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { AxisContextId, AxisWorkHubSourceId } from "./axisContext.ts";

const ENTITY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const LocalTime = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));
const DayOfWeek = NonNegativeInt.check(Schema.isLessThanOrEqualTo(6));

export const AxisScheduledActivityId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(ENTITY_ID_PATTERN),
).pipe(Schema.brand("AxisScheduledActivityId"));
export type AxisScheduledActivityId = typeof AxisScheduledActivityId.Type;

export const AxisScheduledActivityRunId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(ENTITY_ID_PATTERN),
).pipe(Schema.brand("AxisScheduledActivityRunId"));
export type AxisScheduledActivityRunId = typeof AxisScheduledActivityRunId.Type;

export const AxisScheduledActivitySchedule = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("interval"),
    everyMinutes: PositiveInt,
    anchorAt: IsoDateTime,
  }),
  Schema.Struct({
    kind: Schema.Literal("weekly"),
    daysOfWeek: Schema.Array(DayOfWeek).check(Schema.isMinLength(1)),
    localTime: LocalTime,
    timezone: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  }),
]);
export type AxisScheduledActivitySchedule = typeof AxisScheduledActivitySchedule.Type;

export const AxisScheduledActivityAction = Schema.Struct({
  kind: Schema.Literal("workHubSync"),
  sourceIds: Schema.Array(AxisWorkHubSourceId).check(Schema.isMinLength(1)),
});
export type AxisScheduledActivityAction = typeof AxisScheduledActivityAction.Type;

export const AxisScheduledActivityLastRunStatus = Schema.Literals([
  "running",
  "succeeded",
  "partial",
  "failed",
]);
export type AxisScheduledActivityLastRunStatus = typeof AxisScheduledActivityLastRunStatus.Type;

export const AxisScheduledActivity = Schema.Struct({
  id: AxisScheduledActivityId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  contextId: AxisContextId,
  action: AxisScheduledActivityAction,
  schedule: AxisScheduledActivitySchedule,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  nextRunAt: IsoDateTime,
  lastRunAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  lastRunStatus: Schema.NullOr(AxisScheduledActivityLastRunStatus).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastRunMessage: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AxisScheduledActivity = typeof AxisScheduledActivity.Type;

/** User-authored fields. Lifecycle timestamps and run state are server-owned. */
export const AxisScheduledActivityDraft = Schema.Struct({
  id: AxisScheduledActivityId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  contextId: AxisContextId,
  action: AxisScheduledActivityAction,
  schedule: AxisScheduledActivitySchedule,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type AxisScheduledActivityDraft = typeof AxisScheduledActivityDraft.Type;

export const AxisScheduledActivitySourceRun = Schema.Struct({
  sourceId: AxisWorkHubSourceId,
  status: Schema.Literals(["succeeded", "failed", "skipped"]),
  itemCount: NonNegativeInt,
  message: Schema.NullOr(Schema.String),
});
export type AxisScheduledActivitySourceRun = typeof AxisScheduledActivitySourceRun.Type;

export const AxisScheduledActivityRun = Schema.Struct({
  id: AxisScheduledActivityRunId,
  activityId: AxisScheduledActivityId,
  trigger: Schema.Literals(["manual", "scheduled"]),
  status: AxisScheduledActivityLastRunStatus,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(Schema.String),
  sourceResults: Schema.Array(AxisScheduledActivitySourceRun),
});
export type AxisScheduledActivityRun = typeof AxisScheduledActivityRun.Type;

export const AxisScheduledActivityCreateInput = Schema.Struct({
  activity: AxisScheduledActivityDraft,
});
export type AxisScheduledActivityCreateInput = typeof AxisScheduledActivityCreateInput.Type;

export const AxisScheduledActivityUpdateInput = Schema.Struct({
  activity: AxisScheduledActivityDraft,
});
export type AxisScheduledActivityUpdateInput = typeof AxisScheduledActivityUpdateInput.Type;

export const AxisScheduledActivityDeleteInput = Schema.Struct({ id: AxisScheduledActivityId });
export type AxisScheduledActivityDeleteInput = typeof AxisScheduledActivityDeleteInput.Type;

export const AxisScheduledActivityRunNowInput = Schema.Struct({ id: AxisScheduledActivityId });
export type AxisScheduledActivityRunNowInput = typeof AxisScheduledActivityRunNowInput.Type;

export const AxisScheduledActivityListRunsInput = Schema.Struct({
  activityId: AxisScheduledActivityId,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(100)).pipe(
    Schema.withDecodingDefault(Effect.succeed(20)),
  ),
});
export type AxisScheduledActivityListRunsInput = typeof AxisScheduledActivityListRunsInput.Type;

export class AxisScheduledActivityNotFoundError extends Schema.TaggedErrorClass<AxisScheduledActivityNotFoundError>()(
  "AxisScheduledActivityNotFoundError",
  { id: AxisScheduledActivityId },
) {}

export class AxisScheduledActivityConflictError extends Schema.TaggedErrorClass<AxisScheduledActivityConflictError>()(
  "AxisScheduledActivityConflictError",
  { id: AxisScheduledActivityId },
) {}

export class AxisScheduledActivityValidationError extends Schema.TaggedErrorClass<AxisScheduledActivityValidationError>()(
  "AxisScheduledActivityValidationError",
  { message: Schema.String },
) {}

export class AxisScheduledActivityPersistenceError extends Schema.TaggedErrorClass<AxisScheduledActivityPersistenceError>()(
  "AxisScheduledActivityPersistenceError",
  { operation: Schema.String },
) {}

export const AxisScheduledActivityError = Schema.Union([
  AxisScheduledActivityNotFoundError,
  AxisScheduledActivityConflictError,
  AxisScheduledActivityValidationError,
  AxisScheduledActivityPersistenceError,
]);
export type AxisScheduledActivityError = typeof AxisScheduledActivityError.Type;

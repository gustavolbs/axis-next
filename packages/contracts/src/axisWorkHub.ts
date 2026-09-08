import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  AxisCapabilityId,
  AxisContextId,
  AxisWorkHubCollectionPolicy,
  AxisProviderInstanceLocator,
  AxisWorkHubSourceId,
} from "./axisContext.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AxisWorkHubItemId = TrimmedNonEmptyString.pipe(Schema.brand("AxisWorkHubItemId"));
export type AxisWorkHubItemId = typeof AxisWorkHubItemId.Type;

export const AxisWorkHubView = Schema.Literals(["overview", "calendar", "messages", "board"]);
export type AxisWorkHubView = typeof AxisWorkHubView.Type;

export const AxisWorkHubItemKind = Schema.Literals([
  "calendar-event",
  "assigned-work-item",
  "direct-message",
  "mention",
  "assigned-issue-comment",
]);
export type AxisWorkHubItemKind = typeof AxisWorkHubItemKind.Type;

/** A connector's civil calendar date, intentionally independent of a timezone. */
export const AxisWorkHubCalendarDate = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u),
    Schema.makeFilter((value) => {
      const [yearPart, monthPart, dayPart] = value.split("-");
      const year = Number(yearPart);
      const month = Number(monthPart);
      const day = Number(dayPart);
      const daysInMonth =
        month === 2
          ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
            ? 29
            : 28
          : ([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0);
      return (
        (month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth) ||
        "Calendar date must be a valid Gregorian date."
      );
    }),
  ),
  Schema.brand("AxisWorkHubCalendarDate"),
);
export type AxisWorkHubCalendarDate = typeof AxisWorkHubCalendarDate.Type;

export const AxisWorkHubCalendarResponseStatus = Schema.Literals([
  "none",
  "needs-action",
  "accepted",
  "declined",
  "tentative",
  "organizer",
]);
export type AxisWorkHubCalendarResponseStatus = typeof AxisWorkHubCalendarResponseStatus.Type;

export const AxisWorkHubCalendarPerson = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
});
export type AxisWorkHubCalendarPerson = typeof AxisWorkHubCalendarPerson.Type;

export const AxisWorkHubCalendarParticipant = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  responseStatus: Schema.NullOr(AxisWorkHubCalendarResponseStatus),
});
export type AxisWorkHubCalendarParticipant = typeof AxisWorkHubCalendarParticipant.Type;

export const AxisWorkHubCalendarIdentity = Schema.Struct({
  nativeId: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
});
export type AxisWorkHubCalendarIdentity = typeof AxisWorkHubCalendarIdentity.Type;

export const AxisWorkHubCalendarRecurrence = Schema.Struct({
  seriesId: Schema.NullOr(Schema.String),
  rule: Schema.NullOr(Schema.String),
});
export type AxisWorkHubCalendarRecurrence = typeof AxisWorkHubCalendarRecurrence.Type;

const CalendarMetadataFields = {
  /** IANA time zone supplied by the source, independent of the viewer's zone. */
  sourceTimeZone: Schema.NullOr(Schema.String),
  calendar: Schema.NullOr(AxisWorkHubCalendarIdentity),
  organizer: Schema.NullOr(AxisWorkHubCalendarPerson),
  participants: Schema.Array(AxisWorkHubCalendarParticipant),
  responseStatus: Schema.NullOr(AxisWorkHubCalendarResponseStatus),
  recurrence: Schema.NullOr(AxisWorkHubCalendarRecurrence),
  cancelled: Schema.Boolean,
};

/** Provider-produced item before Axis attaches source identity and cache metadata. */
export const AxisWorkHubCollectedItem = Schema.Struct({
  kind: AxisWorkHubItemKind,
  view: AxisWorkHubView,
  nativeId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  summary: Schema.NullOr(Schema.String),
  occurredAt: Schema.NullOr(IsoDateTime),
  startsAt: Schema.NullOr(IsoDateTime),
  endsAt: Schema.NullOr(IsoDateTime),
  /** Calendar events may use date-only semantics; all-day ranges end exclusively. */
  allDay: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  startDate: Schema.NullOr(AxisWorkHubCalendarDate).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  endDate: Schema.NullOr(AxisWorkHubCalendarDate).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  sourceTimeZone: CalendarMetadataFields.sourceTimeZone.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  calendar: CalendarMetadataFields.calendar.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  organizer: CalendarMetadataFields.organizer.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  participants: CalendarMetadataFields.participants.pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  responseStatus: CalendarMetadataFields.responseStatus.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  recurrence: CalendarMetadataFields.recurrence.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  cancelled: CalendarMetadataFields.cancelled.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  status: Schema.NullOr(Schema.String),
  assignee: Schema.optionalKey(Schema.NullOr(Schema.String)),
  priority: Schema.optionalKey(Schema.NullOr(Schema.String)),
  dueDate: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  project: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sourceUpdatedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  deepLink: Schema.NullOr(Schema.String),
  meetingLink: Schema.NullOr(Schema.String),
  location: Schema.NullOr(Schema.String),
});
export type AxisWorkHubCollectedItem = typeof AxisWorkHubCollectedItem.Type;

export const AxisWorkHubCollectionResult = Schema.Struct({
  items: Schema.Array(AxisWorkHubCollectedItem),
  cursor: Schema.NullOr(Schema.String),
});
export type AxisWorkHubCollectionResult = typeof AxisWorkHubCollectionResult.Type;

/** Connector-neutral record retained in the source-scoped Work Hub cache. */
export const AxisWorkHubCachedItem = Schema.Struct({
  id: AxisWorkHubItemId,
  sourceId: AxisWorkHubSourceId,
  contextId: AxisContextId,
  kind: AxisWorkHubItemKind,
  view: AxisWorkHubView,
  nativeId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  summary: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  occurredAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  startsAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  endsAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  allDay: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  startDate: Schema.NullOr(AxisWorkHubCalendarDate).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  endDate: Schema.NullOr(AxisWorkHubCalendarDate).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  sourceTimeZone: CalendarMetadataFields.sourceTimeZone.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  calendar: CalendarMetadataFields.calendar.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  organizer: CalendarMetadataFields.organizer.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  participants: CalendarMetadataFields.participants.pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  responseStatus: CalendarMetadataFields.responseStatus.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  recurrence: CalendarMetadataFields.recurrence.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  cancelled: CalendarMetadataFields.cancelled.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  status: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  assignee: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  priority: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  dueDate: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  labels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  project: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  sourceUpdatedAt: Schema.NullOr(IsoDateTime).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  deepLink: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  meetingLink: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  location: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  updatedAt: IsoDateTime,
});
export type AxisWorkHubCachedItem = typeof AxisWorkHubCachedItem.Type;

/** Last confirmed response for one context/provider/MCP source. */
export const AxisWorkHubCacheSnapshot = Schema.Struct({
  sourceId: AxisWorkHubSourceId,
  contextId: AxisContextId,
  provider: AxisProviderInstanceLocator,
  capabilityId: AxisCapabilityId,
  items: Schema.Array(AxisWorkHubCachedItem),
  cursor: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  refreshedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type AxisWorkHubCacheSnapshot = typeof AxisWorkHubCacheSnapshot.Type;

/** The most recent collection state for one catalog-owned Work Hub source. */
export const AxisWorkHubSourceSyncState = Schema.Literals([
  "fresh",
  "stale",
  "error",
  "authorization-required",
]);
export type AxisWorkHubSourceSyncState = typeof AxisWorkHubSourceSyncState.Type;

export const AxisWorkHubSourceErrorKind = Schema.Literals(["authorization", "transient"]);
export type AxisWorkHubSourceErrorKind = typeof AxisWorkHubSourceErrorKind.Type;

/**
 * A source diagnostic is kept independently from its last good snapshot so a
 * failed collection never discards usable cached items.
 */
export const AxisWorkHubSourceStatus = Schema.Struct({
  sourceId: AxisWorkHubSourceId,
  status: AxisWorkHubSourceSyncState,
  lastConfirmedSuccessAt: Schema.NullOr(IsoDateTime),
  lastErrorAt: Schema.NullOr(IsoDateTime),
  lastErrorKind: Schema.NullOr(AxisWorkHubSourceErrorKind),
  lastErrorMessage: Schema.NullOr(TrimmedNonEmptyString),
  snapshot: Schema.NullOr(AxisWorkHubCacheSnapshot),
});
export type AxisWorkHubSourceStatus = typeof AxisWorkHubSourceStatus.Type;

/** Public request to synchronize one catalog-owned Work Hub source. */
export const AxisWorkHubSourceSyncInput = Schema.Struct({
  sourceId: AxisWorkHubSourceId,
});
export type AxisWorkHubSourceSyncInput = typeof AxisWorkHubSourceSyncInput.Type;

/**
 * Fully resolved provider request. This is assembled server-side from the Axis
 * catalog and the previous cache snapshot; clients must never author it.
 */
export const AxisWorkHubCollectInput = Schema.Struct({
  sourceId: AxisWorkHubSourceId,
  contextId: AxisContextId,
  provider: AxisProviderInstanceLocator,
  capabilityId: AxisCapabilityId,
  mcpName: TrimmedNonEmptyString,
  collectionPolicy: AxisWorkHubCollectionPolicy,
  cacheTtlSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(8 * 60 * 60)),
  previousCursor: Schema.NullOr(Schema.String),
});
export type AxisWorkHubCollectInput = typeof AxisWorkHubCollectInput.Type;

export class AxisWorkHubCachePersistenceError extends Schema.TaggedErrorClass<AxisWorkHubCachePersistenceError>()(
  "AxisWorkHubCachePersistenceError",
  { operation: Schema.String },
) {}

export class AxisWorkHubSyncError extends Schema.TaggedErrorClass<AxisWorkHubSyncError>()(
  "AxisWorkHubSyncError",
  {
    sourceId: AxisWorkHubSourceId,
    instanceId: ProviderInstanceId,
    message: TrimmedNonEmptyString,
  },
) {}

export class AxisWorkHubSourceValidationError extends Schema.TaggedErrorClass<AxisWorkHubSourceValidationError>()(
  "AxisWorkHubSourceValidationError",
  {
    sourceId: AxisWorkHubSourceId,
    message: TrimmedNonEmptyString,
  },
) {}

export function isAxisWorkHubCacheFresh(
  snapshot: AxisWorkHubCacheSnapshot,
  nowEpochMs: number,
): boolean {
  const expiresAt = Date.parse(snapshot.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > nowEpochMs;
}

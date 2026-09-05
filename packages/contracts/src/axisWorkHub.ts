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
  status: Schema.NullOr(Schema.String),
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
  status: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
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

export const AxisWorkHubCollectInput = Schema.Struct({
  sourceId: AxisWorkHubSourceId,
  contextId: AxisContextId,
  provider: AxisProviderInstanceLocator,
  capabilityId: AxisCapabilityId,
  mcpName: TrimmedNonEmptyString,
  collectionPolicy: AxisWorkHubCollectionPolicy,
  cacheTtlSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(8 * 60 * 60)),
  previousCursor: Schema.NullOr(Schema.String),
  previousRefreshedAt: Schema.NullOr(IsoDateTime),
});
export type AxisWorkHubCollectInput = typeof AxisWorkHubCollectInput.Type;

export const AxisWorkHubReplaceCacheInput = Schema.Struct({
  snapshot: AxisWorkHubCacheSnapshot,
});
export type AxisWorkHubReplaceCacheInput = typeof AxisWorkHubReplaceCacheInput.Type;

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

export function isAxisWorkHubCacheFresh(
  snapshot: AxisWorkHubCacheSnapshot,
  nowEpochMs: number,
): boolean {
  const expiresAt = Date.parse(snapshot.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > nowEpochMs;
}

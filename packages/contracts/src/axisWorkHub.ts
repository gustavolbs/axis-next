import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  AxisCapabilityId,
  AxisContextId,
  AxisProviderInstanceLocator,
  AxisWorkHubSourceId,
} from "./axisContext.ts";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AxisWorkHubItemId = TrimmedNonEmptyString.pipe(Schema.brand("AxisWorkHubItemId"));
export type AxisWorkHubItemId = typeof AxisWorkHubItemId.Type;

export const AxisWorkHubView = Schema.Literals(["overview", "calendar", "messages", "board"]);
export type AxisWorkHubView = typeof AxisWorkHubView.Type;

/** Connector-neutral record retained in the source-scoped Work Hub cache. */
export const AxisWorkHubCachedItem = Schema.Struct({
  id: AxisWorkHubItemId,
  sourceId: AxisWorkHubSourceId,
  contextId: AxisContextId,
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

export class AxisWorkHubCachePersistenceError extends Schema.TaggedErrorClass<AxisWorkHubCachePersistenceError>()(
  "AxisWorkHubCachePersistenceError",
  { operation: Schema.String },
) {}

export function isAxisWorkHubCacheFresh(
  snapshot: AxisWorkHubCacheSnapshot,
  nowEpochMs: number,
): boolean {
  const expiresAt = Date.parse(snapshot.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > nowEpochMs;
}

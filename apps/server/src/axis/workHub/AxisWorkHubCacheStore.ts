import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AxisWorkHubCachePersistenceError,
  AxisWorkHubCacheSnapshot,
  AxisWorkHubSourceStatus,
  type AxisWorkHubSourceErrorKind,
  type AxisWorkHubSourceId,
  isAxisWorkHubCacheFresh,
} from "@t3tools/contracts";

type CacheRow = { readonly snapshotJson: unknown };
type SourceStatusRow = {
  readonly sourceId: string;
  readonly snapshotJson: unknown | null;
  readonly lastConfirmedSuccessAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastErrorKind: string | null;
  readonly lastErrorMessage: string | null;
};
const RETAIN_INCREMENTAL_MESSAGES_MS = 14 * 86_400_000;

export function mergeAxisWorkHubCacheSnapshot(
  previous: AxisWorkHubCacheSnapshot | null,
  incoming: AxisWorkHubCacheSnapshot,
): AxisWorkHubCacheSnapshot {
  if (!previous) return incoming;
  const cutoff = Date.parse(incoming.refreshedAt) - RETAIN_INCREMENTAL_MESSAGES_MS;
  const items = new Map(
    previous.items
      .filter(
        (item) =>
          item.view === "messages" &&
          item.occurredAt !== null &&
          Date.parse(item.occurredAt) >= cutoff,
      )
      .map((item) => [`${item.kind}\u0000${item.nativeId}`, item] as const),
  );
  for (const item of incoming.items) {
    items.set(`${item.kind}\u0000${item.nativeId}`, item);
  }
  return { ...incoming, items: [...items.values()] };
}

const decodeSnapshotJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AxisWorkHubCacheSnapshot),
);
const encodeSnapshotJson = Schema.encodeEffect(Schema.fromJsonString(AxisWorkHubCacheSnapshot));
const decodeSourceStatus = Schema.decodeUnknownEffect(AxisWorkHubSourceStatus);
const persistenceError = (operation: string) => () =>
  new AxisWorkHubCachePersistenceError({ operation });

export class AxisWorkHubCacheStore extends Context.Service<
  AxisWorkHubCacheStore,
  {
    readonly get: (
      sourceId: AxisWorkHubSourceId,
    ) => Effect.Effect<AxisWorkHubCacheSnapshot | null, AxisWorkHubCachePersistenceError>;
    readonly list: Effect.Effect<
      ReadonlyArray<AxisWorkHubCacheSnapshot>,
      AxisWorkHubCachePersistenceError
    >;
    readonly listStatuses: Effect.Effect<
      ReadonlyArray<AxisWorkHubSourceStatus>,
      AxisWorkHubCachePersistenceError
    >;
    readonly replace: (
      snapshot: AxisWorkHubCacheSnapshot,
    ) => Effect.Effect<void, AxisWorkHubCachePersistenceError>;
    readonly recordFailure: (
      sourceId: AxisWorkHubSourceId,
      failure: {
        readonly occurredAt: string;
        readonly kind: AxisWorkHubSourceErrorKind;
        readonly message: string;
      },
    ) => Effect.Effect<void, AxisWorkHubCachePersistenceError>;
    readonly remove: (
      sourceId: AxisWorkHubSourceId,
    ) => Effect.Effect<void, AxisWorkHubCachePersistenceError>;
  }
>()("t3/axis/workHub/AxisWorkHubCacheStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const get: AxisWorkHubCacheStore["Service"]["get"] = (sourceId) =>
    sql<CacheRow>`
      SELECT cache.snapshot_json AS "snapshotJson"
      FROM axis_work_hub_cache AS cache
      WHERE cache.source_id = ${sourceId}
        AND EXISTS (
          SELECT 1
          FROM axis_context_catalog AS catalog,
               json_each(catalog.catalog_json, '$.workHubSources') AS source
          WHERE catalog.singleton = 1
            AND json_extract(source.value, '$.id') = cache.source_id
            AND json_extract(source.value, '$.contextId') = cache.context_id
            AND json_extract(source.value, '$.capabilityId') =
                json_extract(cache.snapshot_json, '$.capabilityId')
            AND EXISTS (
              SELECT 1 FROM json_each(catalog.catalog_json, '$.contexts') AS context
              WHERE json_extract(context.value, '$.id') = cache.context_id
            )
            AND EXISTS (
              SELECT 1 FROM json_each(catalog.catalog_json, '$.capabilities') AS capability
              WHERE json_extract(capability.value, '$.id') =
                    json_extract(source.value, '$.capabilityId')
            )
        )
    `.pipe(
      Effect.mapError(persistenceError("read cache snapshot")),
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(null)
          : decodeSnapshotJson(rows[0].snapshotJson).pipe(
              Effect.mapError(persistenceError("decode cache snapshot")),
            ),
      ),
    );

  const list: AxisWorkHubCacheStore["Service"]["list"] = sql<CacheRow>`
    SELECT cache.snapshot_json AS "snapshotJson"
    FROM axis_work_hub_cache AS cache
    WHERE EXISTS (
      SELECT 1
      FROM axis_context_catalog AS catalog,
           json_each(catalog.catalog_json, '$.workHubSources') AS source
      WHERE catalog.singleton = 1
        AND json_extract(source.value, '$.id') = cache.source_id
        AND json_extract(source.value, '$.contextId') = cache.context_id
        AND json_extract(source.value, '$.capabilityId') =
            json_extract(cache.snapshot_json, '$.capabilityId')
        AND EXISTS (
          SELECT 1 FROM json_each(catalog.catalog_json, '$.contexts') AS context
          WHERE json_extract(context.value, '$.id') = cache.context_id
        )
        AND EXISTS (
          SELECT 1 FROM json_each(catalog.catalog_json, '$.capabilities') AS capability
          WHERE json_extract(capability.value, '$.id') =
                json_extract(source.value, '$.capabilityId')
        )
    )
    ORDER BY cache.context_id, cache.source_id
  `.pipe(
    Effect.mapError(persistenceError("list cache snapshots")),
    Effect.flatMap((rows) =>
      Effect.forEach(
        rows,
        (row) =>
          decodeSnapshotJson(row.snapshotJson).pipe(
            Effect.mapError(persistenceError("decode cache snapshots")),
          ),
        { concurrency: 8 },
      ),
    ),
  );

  const listStatuses: AxisWorkHubCacheStore["Service"]["listStatuses"] = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const rows = yield* sql<SourceStatusRow>`
        SELECT
          json_extract(source.value, '$.id') AS "sourceId",
          cache.snapshot_json AS "snapshotJson",
          COALESCE(status.last_confirmed_success_at, cache.refreshed_at) AS "lastConfirmedSuccessAt",
          status.last_error_at AS "lastErrorAt",
          status.last_error_kind AS "lastErrorKind",
          status.last_error_message AS "lastErrorMessage"
        FROM axis_context_catalog AS catalog,
             json_each(catalog.catalog_json, '$.workHubSources') AS source
        LEFT JOIN axis_work_hub_cache AS cache
          ON cache.source_id = json_extract(source.value, '$.id')
         AND cache.context_id = json_extract(source.value, '$.contextId')
         AND json_extract(cache.snapshot_json, '$.capabilityId') =
             json_extract(source.value, '$.capabilityId')
        LEFT JOIN axis_work_hub_source_status AS status
          ON status.source_id = json_extract(source.value, '$.id')
        WHERE catalog.singleton = 1
        ORDER BY json_extract(source.value, '$.contextId'), json_extract(source.value, '$.id')
      `.pipe(Effect.mapError(persistenceError("list Work Hub source statuses")));
    return yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const snapshot =
            row.snapshotJson === null
              ? null
              : yield* decodeSnapshotJson(row.snapshotJson).pipe(
                  Effect.mapError(persistenceError("decode cache snapshot")),
                );
          return yield* decodeSourceStatus({
            sourceId: row.sourceId,
            status:
              row.lastErrorKind === "authorization"
                ? "authorization-required"
                : row.lastErrorKind === "transient"
                  ? "error"
                  : snapshot && isAxisWorkHubCacheFresh(snapshot, now)
                    ? "fresh"
                    : "stale",
            lastConfirmedSuccessAt: row.lastConfirmedSuccessAt,
            lastErrorAt: row.lastErrorAt,
            lastErrorKind: row.lastErrorKind,
            lastErrorMessage: row.lastErrorMessage,
            snapshot,
          }).pipe(Effect.mapError(persistenceError("decode Work Hub source status")));
        }),
      { concurrency: 8 },
    );
  });

  const replace: AxisWorkHubCacheStore["Service"]["replace"] = (snapshot) =>
    encodeSnapshotJson(snapshot).pipe(
      Effect.mapError(persistenceError("encode cache snapshot")),
      Effect.flatMap((snapshotJson) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly sourceId: string }>`
        INSERT INTO axis_work_hub_cache (
          source_id,
          context_id,
          snapshot_json,
          refreshed_at,
          expires_at
        ) SELECT
          ${snapshot.sourceId},
          ${snapshot.contextId},
          ${snapshotJson},
          ${snapshot.refreshedAt},
          ${snapshot.expiresAt}
        WHERE EXISTS (
          SELECT 1
          FROM axis_context_catalog AS catalog,
               json_each(catalog.catalog_json, '$.workHubSources') AS source
          WHERE catalog.singleton = 1
            AND json_extract(source.value, '$.id') = ${snapshot.sourceId}
            AND json_extract(source.value, '$.contextId') = ${snapshot.contextId}
            AND json_extract(source.value, '$.capabilityId') = ${snapshot.capabilityId}
            AND EXISTS (
              SELECT 1 FROM json_each(catalog.catalog_json, '$.contexts') AS context
              WHERE json_extract(context.value, '$.id') = ${snapshot.contextId}
            )
            AND EXISTS (
              SELECT 1 FROM json_each(catalog.catalog_json, '$.capabilities') AS capability
              WHERE json_extract(capability.value, '$.id') =
                    json_extract(source.value, '$.capabilityId')
            )
        )
        ON CONFLICT (source_id) DO UPDATE SET
          context_id = excluded.context_id,
          snapshot_json = excluded.snapshot_json,
          refreshed_at = excluded.refreshed_at,
          expires_at = excluded.expires_at
        RETURNING source_id AS "sourceId"
      `;
            if (rows[0] !== undefined) {
              yield* sql`
                INSERT INTO axis_work_hub_source_status (
                  source_id, last_confirmed_success_at, last_error_at, last_error_kind, last_error_message
                ) VALUES (
                  ${snapshot.sourceId}, ${snapshot.refreshedAt}, NULL, NULL, NULL
                )
                ON CONFLICT (source_id) DO UPDATE SET
                  last_confirmed_success_at = excluded.last_confirmed_success_at,
                  last_error_at = NULL,
                  last_error_kind = NULL,
                  last_error_message = NULL
              `;
            }
          }),
        ),
      ),
      Effect.asVoid,
      Effect.mapError(persistenceError("replace cache snapshot")),
    );

  const recordFailure: AxisWorkHubCacheStore["Service"]["recordFailure"] = (sourceId, failure) => {
    const message = failure.message.replace(/\s+/gu, " ").trim().slice(0, 1_000);
    return sql`
      INSERT INTO axis_work_hub_source_status (
        source_id, last_confirmed_success_at, last_error_at, last_error_kind, last_error_message
      )
      SELECT ${sourceId}, NULL, ${failure.occurredAt}, ${failure.kind}, ${message || "Work Hub source sync failed."}
      WHERE EXISTS (
        SELECT 1
        FROM axis_context_catalog AS catalog,
             json_each(catalog.catalog_json, '$.workHubSources') AS source
        WHERE catalog.singleton = 1
          AND json_extract(source.value, '$.id') = ${sourceId}
      )
      ON CONFLICT (source_id) DO UPDATE SET
        last_error_at = excluded.last_error_at,
        last_error_kind = excluded.last_error_kind,
        last_error_message = excluded.last_error_message
    `.pipe(Effect.asVoid, Effect.mapError(persistenceError("record Work Hub source failure")));
  };

  const remove: AxisWorkHubCacheStore["Service"]["remove"] = (sourceId) =>
    sql
      .withTransaction(
        sql`DELETE FROM axis_work_hub_cache WHERE source_id = ${sourceId}`.pipe(
          Effect.andThen(
            sql`DELETE FROM axis_work_hub_source_status WHERE source_id = ${sourceId}`,
          ),
        ),
      )
      .pipe(Effect.asVoid, Effect.mapError(persistenceError("remove cache snapshot")));

  return {
    get,
    list,
    listStatuses,
    replace,
    recordFailure,
    remove,
  } satisfies AxisWorkHubCacheStore["Service"];
});

export const layer = Layer.effect(AxisWorkHubCacheStore, make);

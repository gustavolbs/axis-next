import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AxisWorkHubCachePersistenceError,
  AxisWorkHubCacheSnapshot,
  type AxisWorkHubSourceId,
} from "@t3tools/contracts";

type CacheRow = { readonly snapshotJson: unknown };
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
    readonly replace: (
      snapshot: AxisWorkHubCacheSnapshot,
    ) => Effect.Effect<void, AxisWorkHubCachePersistenceError>;
    readonly remove: (
      sourceId: AxisWorkHubSourceId,
    ) => Effect.Effect<void, AxisWorkHubCachePersistenceError>;
  }
>()("t3/axis/workHub/AxisWorkHubCacheStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const decodeRows = (rows: ReadonlyArray<CacheRow>) =>
    Effect.forEach(rows, (row) => decodeSnapshotJson(row.snapshotJson), { concurrency: 8 }).pipe(
      Effect.mapError(persistenceError("decode cache snapshots")),
    );

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
  `.pipe(Effect.mapError(persistenceError("list cache snapshots")), Effect.flatMap(decodeRows));

  const replace: AxisWorkHubCacheStore["Service"]["replace"] = (snapshot) =>
    encodeSnapshotJson(snapshot).pipe(
      Effect.mapError(persistenceError("encode cache snapshot")),
      Effect.flatMap(
        (snapshotJson) => sql`
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
      `,
      ),
      Effect.asVoid,
      Effect.mapError(persistenceError("replace cache snapshot")),
    );

  const remove: AxisWorkHubCacheStore["Service"]["remove"] = (sourceId) =>
    sql`DELETE FROM axis_work_hub_cache WHERE source_id = ${sourceId}`.pipe(
      Effect.asVoid,
      Effect.mapError(persistenceError("remove cache snapshot")),
    );

  return { get, list, replace, remove } satisfies AxisWorkHubCacheStore["Service"];
});

export const layer = Layer.effect(AxisWorkHubCacheStore, make);

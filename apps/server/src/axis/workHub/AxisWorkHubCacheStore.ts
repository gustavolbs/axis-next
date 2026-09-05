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
      SELECT snapshot_json AS "snapshotJson"
      FROM axis_work_hub_cache
      WHERE source_id = ${sourceId}
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
    SELECT snapshot_json AS "snapshotJson"
    FROM axis_work_hub_cache
    ORDER BY context_id, source_id
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
        ) VALUES (
          ${snapshot.sourceId},
          ${snapshot.contextId},
          ${snapshotJson},
          ${snapshot.refreshedAt},
          ${snapshot.expiresAt}
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

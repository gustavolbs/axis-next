import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AxisContextCatalog,
  AxisContextCatalogConflictError,
  type AxisContextCatalogError,
  AxisContextCatalogPersistenceError,
  type AxisContextCatalogReplaceInput,
  AxisContextCatalogSnapshot,
  AxisContextCatalogValidationError,
  validateAxisContextCatalog,
} from "@t3tools/contracts";

type CatalogRow = {
  readonly revision: unknown;
  readonly catalogJson: unknown;
  readonly updatedAt: unknown;
};

const decodeCatalogJson = Schema.decodeUnknownEffect(Schema.fromJsonString(AxisContextCatalog));
const encodeCatalogJson = Schema.encodeEffect(Schema.fromJsonString(AxisContextCatalog));
const decodeCatalogSnapshot = Schema.decodeUnknownEffect(AxisContextCatalogSnapshot);
const decodeCatalogRevision = Schema.decodeUnknownEffect(
  AxisContextCatalogSnapshot.fields.revision,
);
const decodeSnapshot = (row: CatalogRow) =>
  decodeCatalogJson(row.catalogJson).pipe(
    Effect.flatMap((catalog) =>
      decodeCatalogSnapshot({
        revision: row.revision,
        catalog,
        updatedAt: row.updatedAt,
      }),
    ),
    Effect.mapError(
      () => new AxisContextCatalogPersistenceError({ operation: "decode catalog snapshot" }),
    ),
  );

const persistenceError = (operation: string) => () =>
  new AxisContextCatalogPersistenceError({ operation });

export class AxisContextCatalogStore extends Context.Service<
  AxisContextCatalogStore,
  {
    readonly get: Effect.Effect<AxisContextCatalogSnapshot, AxisContextCatalogPersistenceError>;
    readonly replace: (
      input: AxisContextCatalogReplaceInput,
    ) => Effect.Effect<AxisContextCatalogSnapshot, AxisContextCatalogError>;
  }
>()("t3/axis/contexts/AxisContextCatalogStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readRows = () =>
    sql<CatalogRow>`
      SELECT
        revision AS "revision",
        catalog_json AS "catalogJson",
        updated_at AS "updatedAt"
      FROM axis_context_catalog
      WHERE singleton = 1
    `;

  const get: AxisContextCatalogStore["Service"]["get"] = readRows().pipe(
    Effect.mapError(persistenceError("read catalog")),
    Effect.flatMap((rows) => {
      const row = rows[0];
      return row === undefined
        ? Effect.fail(new AxisContextCatalogPersistenceError({ operation: "read missing catalog" }))
        : decodeSnapshot(row);
    }),
  );

  const replace: AxisContextCatalogStore["Service"]["replace"] = (input) => {
    const issues = validateAxisContextCatalog(input.catalog);
    if (issues.length > 0) {
      return Effect.fail(new AxisContextCatalogValidationError({ issues }));
    }

    return Effect.gen(function* () {
      const catalogJson = yield* encodeCatalogJson(input.catalog).pipe(
        Effect.mapError(persistenceError("encode replacement catalog")),
      );
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<CatalogRow>`
            UPDATE axis_context_catalog
            SET
              revision = revision + 1,
              catalog_json = ${catalogJson},
              updated_at = ${updatedAt}
            WHERE singleton = 1
              AND revision = ${input.expectedRevision}
            RETURNING
              revision AS "revision",
              catalog_json AS "catalogJson",
              updated_at AS "updatedAt"
          `;
          if (rows[0] !== undefined) {
            const contextIds = input.catalog.contexts.map((context) => context.id);
            const sourceIds = input.catalog.workHubSources.map((source) => source.id);
            if (sourceIds.length === 0) {
              yield* sql`DELETE FROM axis_work_hub_cache`;
              yield* sql`DELETE FROM axis_work_hub_source_status`;
            } else {
              yield* sql`
                DELETE FROM axis_work_hub_source_status
                WHERE source_id NOT IN ${sql.in(sourceIds)}
                   OR EXISTS (
                     SELECT 1
                     FROM axis_work_hub_cache AS cache
                     WHERE cache.source_id = axis_work_hub_source_status.source_id
                       AND NOT EXISTS (
                         SELECT 1
                         FROM json_each(${catalogJson}, '$.workHubSources') AS source
                         WHERE json_extract(source.value, '$.id') = cache.source_id
                           AND json_extract(source.value, '$.contextId') = cache.context_id
                           AND json_extract(source.value, '$.provider.environmentId') =
                               json_extract(cache.snapshot_json, '$.provider.environmentId')
                           AND json_extract(source.value, '$.provider.instanceId') =
                               json_extract(cache.snapshot_json, '$.provider.instanceId')
                           AND json_extract(source.value, '$.capabilityId') =
                               json_extract(cache.snapshot_json, '$.capabilityId')
                       )
                   )
              `;
              yield* sql`
                DELETE FROM axis_work_hub_cache
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM json_each(${catalogJson}, '$.workHubSources') AS source
                  WHERE json_extract(source.value, '$.id') = source_id
                    AND json_extract(source.value, '$.contextId') = context_id
                    AND json_extract(source.value, '$.provider.environmentId') =
                        json_extract(snapshot_json, '$.provider.environmentId')
                    AND json_extract(source.value, '$.provider.instanceId') =
                        json_extract(snapshot_json, '$.provider.instanceId')
                    AND json_extract(source.value, '$.capabilityId') =
                        json_extract(snapshot_json, '$.capabilityId')
                )
              `;
            }

            yield* sql`
              DELETE FROM axis_scheduled_activities
              WHERE context_id NOT IN ${sql.in(contextIds)}
                 OR (
                   json_extract(activity_json, '$.action.kind') = 'workHubSync'
                   AND EXISTS (
                     SELECT 1
                     FROM json_each(activity_json, '$.action.sourceIds') AS scheduled_source
                     WHERE NOT EXISTS (
                       SELECT 1
                       FROM json_each(${catalogJson}, '$.workHubSources') AS source
                       WHERE json_extract(source.value, '$.id') = scheduled_source.value
                         AND json_extract(source.value, '$.contextId') = context_id
                     )
                   )
                 )
                 OR (
                   json_extract(activity_json, '$.action.kind') = 'agentTurn'
                   AND (
                     NOT EXISTS (
                       SELECT 1
                       FROM json_each(${catalogJson}, '$.projectBindings') AS binding
                       WHERE json_extract(binding.value, '$.contextId') = context_id
                         AND json_extract(binding.value, '$.project.environmentId') =
                             json_extract(activity_json, '$.action.project.environmentId')
                         AND json_extract(binding.value, '$.project.projectId') =
                             json_extract(activity_json, '$.action.project.projectId')
                     )
                     OR NOT EXISTS (
                       SELECT 1
                       FROM json_each(${catalogJson}, '$.providerOwnerships') AS ownership
                       WHERE json_extract(ownership.value, '$.contextId') = context_id
                         AND json_extract(ownership.value, '$.provider.environmentId') =
                             json_extract(activity_json, '$.action.provider.environmentId')
                         AND json_extract(ownership.value, '$.provider.instanceId') =
                             json_extract(activity_json, '$.action.provider.instanceId')
                       UNION ALL
                       SELECT 1
                       FROM json_each(${catalogJson}, '$.providerAccessGrants') AS grant
                       WHERE json_extract(grant.value, '$.targetContextId') = context_id
                         AND json_extract(grant.value, '$.status') = 'active'
                         AND json_extract(grant.value, '$.provider.environmentId') =
                             json_extract(activity_json, '$.action.provider.environmentId')
                         AND json_extract(grant.value, '$.provider.instanceId') =
                             json_extract(activity_json, '$.action.provider.instanceId')
                     )
                   )
                 )
            `;

            yield* sql`
              DELETE FROM axis_learning_active_versions
              WHERE context_id NOT IN ${sql.in(contextIds)}
            `;
            yield* sql`
              DELETE FROM axis_learning_lifecycle_events
              WHERE context_id NOT IN ${sql.in(contextIds)}
            `;
            yield* sql`
              DELETE FROM axis_learning_versions
              WHERE context_id NOT IN ${sql.in(contextIds)}
            `;
            yield* sql`
              DELETE FROM axis_learning_proposals
              WHERE context_id NOT IN ${sql.in(contextIds)}
            `;
            yield* sql`
              DELETE FROM axis_learning_evidence
              WHERE context_id NOT IN ${sql.in(contextIds)}
            `;
          }
          return rows;
        }),
      );
    }).pipe(
      Effect.mapError(persistenceError("replace catalog")),
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (row !== undefined) return decodeSnapshot(row);

        return readRows().pipe(
          Effect.mapError(persistenceError("read revision after conflict")),
          Effect.flatMap((currentRows) => {
            const current = currentRows[0];
            return decodeCatalogRevision(current?.revision).pipe(
              Effect.mapError(persistenceError("decode revision after conflict")),
              Effect.flatMap((actualRevision) =>
                Effect.fail(
                  new AxisContextCatalogConflictError({
                    expectedRevision: input.expectedRevision,
                    actualRevision,
                  }),
                ),
              ),
            );
          }),
        );
      }),
    );
  };

  return { get, replace } satisfies AxisContextCatalogStore["Service"];
});

export const layer = Layer.effect(AxisContextCatalogStore, make);

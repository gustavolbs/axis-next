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
            const sourceIds = input.catalog.workHubSources.map((source) => source.id);
            if (sourceIds.length === 0) {
              yield* sql`DELETE FROM axis_work_hub_cache`;
            } else {
              yield* sql`
                DELETE FROM axis_work_hub_cache
                WHERE source_id NOT IN ${sql.in(sourceIds)}
              `;
            }
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

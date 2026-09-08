import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TRIGGER axis_learning_versions_immutable_delete`;
  yield* sql`
    CREATE TRIGGER axis_learning_versions_immutable_delete
    BEFORE DELETE ON axis_learning_versions
    WHEN EXISTS (
      SELECT 1
      FROM axis_context_catalog AS catalog,
           json_each(catalog.catalog_json, '$.contexts') AS context
      WHERE catalog.singleton = 1
        AND json_extract(context.value, '$.id') = OLD.context_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Axis learning versions are immutable');
    END
  `;

  yield* sql`DROP TRIGGER axis_learning_lifecycle_immutable_delete`;
  yield* sql`
    CREATE TRIGGER axis_learning_lifecycle_immutable_delete
    BEFORE DELETE ON axis_learning_lifecycle_events
    WHEN EXISTS (
      SELECT 1
      FROM axis_context_catalog AS catalog,
           json_each(catalog.catalog_json, '$.contexts') AS context
      WHERE catalog.singleton = 1
        AND json_extract(context.value, '$.id') = OLD.context_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Axis learning lifecycle events are immutable');
    END
  `;
});

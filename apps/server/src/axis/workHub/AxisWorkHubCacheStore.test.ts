import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AxisContextCatalog,
  AxisWorkHubCacheSnapshot,
  AxisWorkHubSourceId,
} from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  AxisContextCatalogStore,
  layer as catalogStoreLayer,
} from "../contexts/AxisContextCatalogStore.ts";
import {
  AxisWorkHubCacheStore,
  layer as storeLayer,
  mergeAxisWorkHubCacheSnapshot,
} from "./AxisWorkHubCacheStore.ts";

const persistence = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  persistence,
  catalogStoreLayer.pipe(Layer.provide(persistence)),
  storeLayer.pipe(Layer.provide(persistence)),
);
const layer = it.layer(testLayer);
const decodeSnapshot = Schema.decodeUnknownSync(AxisWorkHubCacheSnapshot);
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(AxisWorkHubCacheSnapshot));
const decodeCatalog = Schema.decodeUnknownSync(AxisContextCatalog);

const addCatalogSource = Effect.gen(function* () {
  const catalogs = yield* AxisContextCatalogStore;
  const initial = yield* catalogs.get;
  yield* catalogs.replace({
    expectedRevision: initial.revision,
    catalog: decodeCatalog({
      ...initial.catalog,
      providerOwnerships: [
        { contextId: "personal", provider: { environmentId: "env", instanceId: "codex" } },
      ],
      capabilities: [
        {
          id: "jira",
          provider: { environmentId: "env", instanceId: "codex" },
          kind: "mcp",
          name: "Jira",
          enabled: true,
          createdAt: initial.updatedAt,
          updatedAt: initial.updatedAt,
        },
      ],
      workHubSources: [
        {
          id: "jira_company_a",
          contextId: "personal",
          provider: { environmentId: "env", instanceId: "codex" },
          capabilityId: "jira",
          enabled: true,
          createdAt: initial.updatedAt,
          updatedAt: initial.updatedAt,
        },
      ],
    }),
  });
});

it("retains recent incremental messages when replacing a source snapshot", () => {
  const previous = decodeSnapshot({
    sourceId: "slack_personal",
    contextId: "personal",
    provider: { environmentId: "env", instanceId: "codex" },
    capabilityId: "slack",
    items: [
      {
        id: "old-message",
        sourceId: "slack_personal",
        contextId: "personal",
        kind: "mention",
        view: "messages",
        nativeId: "message-1",
        title: "Existing mention",
        occurredAt: "2026-09-04T12:00:00.000Z",
        updatedAt: "2026-09-04T12:00:00.000Z",
      },
    ],
    refreshedAt: "2026-09-04T12:00:00.000Z",
    expiresAt: "2026-09-04T20:00:00.000Z",
  });
  const incoming = decodeSnapshot({
    ...previous,
    items: [
      {
        id: "new-message",
        sourceId: "slack_personal",
        contextId: "personal",
        kind: "direct-message",
        view: "messages",
        nativeId: "message-2",
        title: "New direct message",
        occurredAt: "2026-09-05T11:00:00.000Z",
        updatedAt: "2026-09-05T12:00:00.000Z",
      },
    ],
    refreshedAt: "2026-09-05T12:00:00.000Z",
    expiresAt: "2026-09-05T20:00:00.000Z",
  });

  assert.deepEqual(
    mergeAxisWorkHubCacheSnapshot(previous, incoming).items.map((item) => item.nativeId),
    ["message-1", "message-2"],
  );
});

layer("AxisWorkHubCacheStore", (it) => {
  it.effect("atomically replaces and removes one source snapshot", () =>
    Effect.gen(function* () {
      const store = yield* AxisWorkHubCacheStore;
      yield* addCatalogSource;
      const snapshot = decodeSnapshot({
        sourceId: "jira_company_a",
        contextId: "personal",
        provider: { environmentId: "env", instanceId: "codex" },
        capabilityId: "jira",
        items: [],
        refreshedAt: "2026-09-05T00:00:00.000Z",
        expiresAt: "2026-09-05T08:00:00.000Z",
      });

      yield* store.replace(snapshot);
      assert.deepEqual(yield* store.get(snapshot.sourceId), snapshot);
      assert.equal((yield* store.list).length, 1);

      yield* store.remove(AxisWorkHubSourceId.make("jira_company_a"));
      assert.equal(yield* store.get(snapshot.sourceId), null);
    }),
  );

  it.effect("hides cache snapshots that are not backed by the current catalog", () =>
    Effect.gen(function* () {
      const store = yield* AxisWorkHubCacheStore;
      const sql = yield* SqlClient.SqlClient;
      const orphan = decodeSnapshot({
        sourceId: "orphan_source",
        contextId: "personal",
        provider: { environmentId: "env", instanceId: "codex" },
        capabilityId: "missing_mcp",
        items: [],
        refreshedAt: "2026-09-05T00:00:00.000Z",
        expiresAt: "2026-09-05T08:00:00.000Z",
      });

      const snapshotJson = encodeSnapshot(orphan);
      // Simulate an orphan left by an older server version so the read path,
      // rather than the guarded writer, is what this assertion exercises.
      yield* sql`
        INSERT INTO axis_work_hub_cache (
          source_id, context_id, snapshot_json, refreshed_at, expires_at
        ) VALUES (
          ${orphan.sourceId}, ${orphan.contextId}, ${snapshotJson},
          ${orphan.refreshedAt}, ${orphan.expiresAt}
        )
      `;

      assert.equal(yield* store.get(orphan.sourceId), null);
      assert.deepEqual(yield* store.list, []);
      yield* store.remove(orphan.sourceId);
    }),
  );

  it.effect("does not persist a snapshot after its catalog source was removed", () =>
    Effect.gen(function* () {
      const store = yield* AxisWorkHubCacheStore;
      const sql = yield* SqlClient.SqlClient;
      const orphan = decodeSnapshot({
        sourceId: "removed_source",
        contextId: "personal",
        provider: { environmentId: "env", instanceId: "codex" },
        capabilityId: "removed_mcp",
        items: [],
        refreshedAt: "2026-09-05T00:00:00.000Z",
        expiresAt: "2026-09-05T08:00:00.000Z",
      });

      yield* store.replace(orphan);

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM axis_work_hub_cache WHERE source_id = ${orphan.sourceId}
      `;
      assert.equal(rows[0]?.count, 0);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { AxisWorkHubCacheSnapshot, AxisWorkHubSourceId } from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AxisWorkHubCacheStore, layer as storeLayer } from "./AxisWorkHubCacheStore.ts";

const testLayer = storeLayer.pipe(Layer.provide(SqlitePersistenceMemory));
const layer = it.layer(testLayer);
const decodeSnapshot = Schema.decodeUnknownSync(AxisWorkHubCacheSnapshot);

layer("AxisWorkHubCacheStore", (it) => {
  it.effect("atomically replaces and removes one source snapshot", () =>
    Effect.gen(function* () {
      const store = yield* AxisWorkHubCacheStore;
      const snapshot = decodeSnapshot({
        sourceId: "jira_company_a",
        contextId: "company_a",
        provider: { environmentId: "env", instanceId: "codex" },
        capabilityId: "jira",
        items: [],
        refreshedAt: "2026-09-05T00:00:00.000Z",
        expiresAt: "2026-09-05T00:15:00.000Z",
      });

      yield* store.replace(snapshot);
      assert.deepEqual(yield* store.get(snapshot.sourceId), snapshot);
      assert.equal((yield* store.list).length, 1);

      yield* store.remove(AxisWorkHubSourceId.make("jira_company_a"));
      assert.equal(yield* store.get(snapshot.sourceId), null);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { AxisWorkHubCacheSnapshot, AxisWorkHubSourceId } from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  AxisWorkHubCacheStore,
  layer as storeLayer,
  mergeAxisWorkHubCacheSnapshot,
} from "./AxisWorkHubCacheStore.ts";

const testLayer = storeLayer.pipe(Layer.provide(SqlitePersistenceMemory));
const layer = it.layer(testLayer);
const decodeSnapshot = Schema.decodeUnknownSync(AxisWorkHubCacheSnapshot);

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
      const snapshot = decodeSnapshot({
        sourceId: "jira_company_a",
        contextId: "company_a",
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
});

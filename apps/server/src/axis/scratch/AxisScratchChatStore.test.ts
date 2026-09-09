import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { AxisScratchChat } from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AxisScratchChatStore, layer as storeLayer } from "./AxisScratchChatStore.ts";

const testLayer = Layer.merge(
  SqlitePersistenceMemory,
  storeLayer.pipe(Layer.provide(SqlitePersistenceMemory)),
);
const layer = it.layer(testLayer);
const decodeAxisScratchChat = Schema.decodeUnknownSync(AxisScratchChat);

const baseChat = (id: string): AxisScratchChat =>
  decodeAxisScratchChat({
    id: `scratch_${id}`,
    environmentId: "env-test",
    title: `Chat ${id}`,
    modelSelection: { instanceId: "codex", model: "auto" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    providerInstanceId: "codex",
    contextId: null,
    backingProjectId: `proj-${id}`,
    backingThreadId: `thread-${id}`,
    lastMessagePreview: null,
    messageCount: 0,
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    lastMessageAt: null,
    archivedAt: null,
  });

layer("AxisScratchChatStore", (it) => {
  it.effect("round-trips create / get / list / archive / remove", () =>
    Effect.gen(function* () {
      const store = yield* AxisScratchChatStore;
      const a = baseChat("a");
      const b = baseChat("b");

      yield* store.create(a);
      yield* store.create(b);

      const fetched = yield* store.get(a.id);
      assert.equal(fetched.id, a.id);
      assert.equal(fetched.title, a.title);

      const listed = yield* store.list({
        environmentId: "env-test",
        includeArchived: false,
      });
      assert.equal(listed.length, 2);

      const archived = yield* store.archive(a.id, "2026-09-07T01:00:00.000Z");
      assert.equal(archived.archivedAt, "2026-09-07T01:00:00.000Z");

      const activeOnly = yield* store.list({
        environmentId: "env-test",
        includeArchived: false,
      });
      assert.equal(activeOnly.length, 1);
      assert.equal(activeOnly[0]?.id, b.id);

      const withArchived = yield* store.list({
        environmentId: "env-test",
        includeArchived: true,
      });
      assert.equal(withArchived.length, 2);

      yield* store.remove(a.id);
      const afterRemove = yield* store.list({
        environmentId: "env-test",
        includeArchived: true,
      });
      assert.equal(afterRemove.length, 1);
      assert.equal(afterRemove[0]?.id, b.id);
    }),
  );

  it.effect("updates title via patch and bumps messageCount via setLastMessage", () =>
    Effect.gen(function* () {
      const store = yield* AxisScratchChatStore;
      const chat = baseChat("c");
      yield* store.create(chat);

      const patched = yield* store.patch(
        { id: chat.id, title: "Renamed" },
        "2026-09-07T00:30:00.000Z",
      );
      assert.equal(patched.title, "Renamed");
      assert.equal(patched.updatedAt, "2026-09-07T00:30:00.000Z");

      yield* store.setLastMessage({
        id: chat.id,
        lastMessagePreview: "hello",
        lastMessageAt: "2026-09-07T00:35:00.000Z",
        messageCount: 1,
        updatedAt: "2026-09-07T00:35:00.000Z",
      });

      const refetched = yield* store.get(chat.id);
      assert.equal(refetched.messageCount, 1);
      assert.equal(refetched.lastMessagePreview, "hello");
      assert.equal(refetched.lastMessageAt, "2026-09-07T00:35:00.000Z");
      assert.equal(refetched.updatedAt, "2026-09-07T00:35:00.000Z");
    }),
  );
});

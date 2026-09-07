import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { makeRecoveryStore } from "./recoveryStore.ts";

describe("recoveryStore", () => {
  it.effect("returns an original only to the context that stored it", () =>
    Effect.gen(function* () {
      const store = makeRecoveryStore();
      const handle = yield* store.retain({ contextKey: "ctx-1", original: "hello" });
      expect(yield* store.recover({ contextKey: "ctx-1", handle: handle! })).toBe("hello");
      expect(yield* store.recover({ contextKey: "ctx-2", handle: handle! })).toBeUndefined();
    }),
  );

  it.effect("forgets an original once its handle expires", () =>
    Effect.gen(function* () {
      let now = 1_000;
      const store = makeRecoveryStore({ ttlMs: 100, maxEntries: 8 }, () => now);
      const handle = yield* store.retain({ contextKey: "ctx", original: "hello" });
      now += 99;
      expect(yield* store.recover({ contextKey: "ctx", handle: handle! })).toBe("hello");
      now += 2;
      expect(yield* store.recover({ contextKey: "ctx", handle: handle! })).toBeUndefined();
    }),
  );

  it.effect("drops the oldest entries rather than growing without bound", () =>
    Effect.gen(function* () {
      const store = makeRecoveryStore({ ttlMs: 60_000, maxEntries: 2 });
      const first = yield* store.retain({ contextKey: "ctx", original: "one" });
      yield* store.retain({ contextKey: "ctx", original: "two" });
      yield* store.retain({ contextKey: "ctx", original: "three" });
      expect(yield* store.recover({ contextKey: "ctx", handle: first! })).toBeUndefined();
    }),
  );

  // A store of originals is a store of secrets unless something refuses.
  it.effect("refuses to retain a payload carrying a credential", () =>
    makeRecoveryStore()
      .retain({ contextKey: "ctx", original: "api_key = abcdefghij" })
      .pipe(
        Effect.map((handle) => {
          expect(handle).toBeUndefined();
        }),
      ),
  );
});

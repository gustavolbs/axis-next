import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "./ProviderSessionRuntime.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const makeRuntime = (status: "running" | "stopped", payload: unknown) => ({
  threadId: ThreadId.make("thread-cas"),
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  adapterKey: "codex",
  runtimeMode: "full-access" as const,
  status,
  lastSeenAt: "2026-09-10T12:00:00.000Z",
  resumeCursor: { providerThread: "provider-thread" },
  runtimePayload: payload,
});

const layer = Layer.mergeAll(
  ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
  NodeServices.layer,
);

it.effect("compareAndSet updates only the captured runtime snapshot", () =>
  Effect.gen(function* () {
    const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const initial = makeRuntime("running", { axisContinuationEffect: { status: "prepared" } });
    const next = makeRuntime("running", { axisContinuationEffect: { status: "pending" } });

    yield* repository.upsert(initial);
    assert.equal(yield* repository.compareAndSet({ expected: initial, next }), true);

    const current = yield* repository.getByThreadId({ threadId: initial.threadId });
    assert.equal(Option.isSome(current), true);
    if (Option.isSome(current)) {
      assert.deepEqual(current.value.runtimePayload, next.runtimePayload);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("compareAndSet rejects an external writer's replacement", () =>
  Effect.gen(function* () {
    const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const initial = makeRuntime("running", { version: "captured" });
    const external = {
      ...initial,
      status: "stopped" as const,
      runtimePayload: { version: "external" },
      lastSeenAt: "2026-09-10T12:00:01.000Z",
    };
    const staleNext = makeRuntime("running", { version: "stale-write" });

    yield* repository.upsert(initial);
    yield* repository.upsert(external);
    assert.equal(yield* repository.compareAndSet({ expected: initial, next: staleNext }), false);

    const current = yield* repository.getByThreadId({ threadId: initial.threadId });
    assert.equal(Option.isSome(current), true);
    if (Option.isSome(current)) {
      assert.equal(current.value.status, "stopped");
      assert.deepEqual(current.value.runtimePayload, external.runtimePayload);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("withLease keeps the conditional transaction around its critical section", () =>
  Effect.gen(function* () {
    const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const initial = makeRuntime("running", { lease: "captured" });
    const updated = makeRuntime("running", { lease: "settled" });

    yield* repository.upsert(initial);
    const leased = yield* repository.withLease({
      expected: initial,
      effect: repository.upsert(updated).pipe(Effect.as("committed")),
    });
    assert.equal(Option.isSome(leased), true);

    const current = yield* repository.getByThreadId({ threadId: initial.threadId });
    assert.equal(Option.isSome(current), true);
    if (Option.isSome(current)) {
      assert.deepEqual(current.value.runtimePayload, updated.runtimePayload);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("NULL instance CAS is exact and cannot match a materialized external replacement", () =>
  Effect.gen(function* () {
    const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const legacy = { ...makeRuntime("running", { version: "legacy" }), providerInstanceId: null };
    const promoted = { ...legacy, providerInstanceId: ProviderInstanceId.make("codex") };
    yield* repository.upsert(legacy);
    assert.equal(yield* repository.compareAndSet({ expected: legacy, next: promoted }), true);
    assert.equal(yield* repository.compareAndSet({ expected: legacy, next: legacy }), false);
    assert.deepEqual(
      yield* repository.withLease({
        expected: legacy,
        effect: Effect.die("stale NULL lease must not run"),
      }),
      Option.none(),
    );
    assert.deepEqual(
      Option.getOrThrow(yield* repository.getByThreadId({ threadId: legacy.threadId })),
      promoted,
    );
  }).pipe(Effect.provide(layer)),
);

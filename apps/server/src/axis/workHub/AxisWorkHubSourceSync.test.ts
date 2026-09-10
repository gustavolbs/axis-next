import { assert, it } from "@effect/vitest";
import {
  AxisContextCatalogSnapshot,
  AxisWorkHubCachePersistenceError,
  AxisWorkHubCacheSnapshot,
  EnvironmentId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderDriverError } from "../../provider/Errors.ts";
import { AxisContextCatalogStore } from "../contexts/AxisContextCatalogStore.ts";
import { AxisWorkHubCacheStore } from "./AxisWorkHubCacheStore.ts";
import {
  AxisWorkHubSourceSync,
  classifyAxisWorkHubCollectionFailure,
  layer as sourceSyncLayer,
} from "./AxisWorkHubSourceSync.ts";

const sourceId = "personal_calendar";
const provider = { environmentId: "env", instanceId: "codex" };
const decodeCacheSnapshot = Schema.decodeUnknownSync(AxisWorkHubCacheSnapshot);
const decodeCatalogSnapshot = Schema.decodeUnknownSync(AxisContextCatalogSnapshot);
const snapshot = decodeCacheSnapshot({
  sourceId,
  contextId: "personal",
  provider,
  capabilityId: "calendar",
  items: [],
  cursor: "next",
  refreshedAt: "2026-09-05T08:00:00.000Z",
  expiresAt: "2026-09-05T16:00:00.000Z",
});
const catalog = decodeCatalogSnapshot({
  revision: 1,
  updatedAt: "2026-09-05T00:00:00.000Z",
  catalog: {
    contexts: [
      {
        id: "personal",
        kind: "personal",
        name: "Personal",
        createdAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:00.000Z",
      },
    ],
    projectBindings: [],
    providerOwnerships: [{ contextId: "personal", provider }],
    providerAccessGrants: [],
    capabilities: [
      {
        id: "calendar",
        provider,
        kind: "mcp",
        name: "Calendar",
        enabled: true,
        createdAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:00.000Z",
      },
    ],
    workHubSources: [
      {
        id: sourceId,
        contextId: "personal",
        provider,
        capabilityId: "calendar",
        enabled: true,
        cacheTtlSeconds: 28_800,
        createdAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:00.000Z",
      },
    ],
  },
});

const makeLayer = (
  collectWorkHubSource: NonNullable<ProviderInstance["collectWorkHubSource"]>,
  cache: {
    get: AxisWorkHubCacheStore["Service"]["get"];
    replace: AxisWorkHubCacheStore["Service"]["replace"];
    recordFailure?: AxisWorkHubCacheStore["Service"]["recordFailure"];
  },
  catalogSnapshot = catalog,
) =>
  sourceSyncLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(AxisContextCatalogStore)({ get: Effect.succeed(catalogSnapshot) }),
        Layer.mock(AxisWorkHubCacheStore)({
          get: cache.get,
          list: Effect.succeed([]),
          replace: cache.replace,
          recordFailure: cache.recordFailure ?? (() => Effect.void),
          remove: () => Effect.void,
        }),
        Layer.mock(ProviderInstanceRegistry)({
          getInstance: () =>
            Effect.succeed({
              instanceId: ProviderInstanceId.make("codex"),
              driverKind: "codex",
              enabled: true,
              collectWorkHubSource,
            } as unknown as ProviderInstance),
          listInstances: Effect.succeed([]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
        }),
        Layer.mock(ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
        }),
      ),
    ),
  );

it.effect("coalesces concurrent manual syncs for the same MCP source", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const response = yield* Deferred.make<AxisWorkHubCacheSnapshot>();
    const collect = vi.fn<NonNullable<ProviderInstance["collectWorkHubSource"]>>(() =>
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(response))),
    );
    const replace = vi.fn<AxisWorkHubCacheStore["Service"]["replace"]>(() => Effect.void);
    const program = Effect.gen(function* () {
      const service = yield* AxisWorkHubSourceSync;
      const first = yield* service.sync(snapshot.sourceId, "manual").pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* service.sync(snapshot.sourceId, "manual").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(response, snapshot);
      const outcomes = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
      assert.deepEqual(outcomes, [
        { status: "synced", snapshot },
        { status: "synced", snapshot },
      ]);
    });

    yield* program.pipe(
      Effect.provide(makeLayer(collect, { get: () => Effect.succeed(null), replace })),
    );
    assert.equal(collect.mock.calls.length, 1);
    assert.equal(replace.mock.calls.length, 1);
  }),
);

it.effect("skips scheduled sync while the eight-hour source cache is fresh", () => {
  const fresh = decodeCacheSnapshot({
    ...snapshot,
    refreshedAt: "2099-09-05T08:00:00.000Z",
    expiresAt: "2099-09-05T16:00:00.000Z",
  });
  const collect = vi.fn<NonNullable<ProviderInstance["collectWorkHubSource"]>>(() =>
    Effect.succeed(snapshot),
  );
  const replace = vi.fn<AxisWorkHubCacheStore["Service"]["replace"]>(() => Effect.void);
  return Effect.gen(function* () {
    const service = yield* AxisWorkHubSourceSync;
    const outcome = yield* service.sync(snapshot.sourceId, "scheduled");
    assert.deepEqual(outcome, { status: "skipped", reason: "fresh-cache", snapshot: fresh });
    assert.equal(collect.mock.calls.length, 0);
    assert.equal(replace.mock.calls.length, 0);
  }).pipe(Effect.provide(makeLayer(collect, { get: () => Effect.succeed(fresh), replace })));
});

it.effect("does not overwrite a cache snapshot newer than the provider result", () => {
  const newer = decodeCacheSnapshot({
    ...snapshot,
    cursor: "newer",
    refreshedAt: "2026-09-05T09:00:00.000Z",
    expiresAt: "2026-09-05T17:00:00.000Z",
  });
  let reads = 0;
  const replace = vi.fn<AxisWorkHubCacheStore["Service"]["replace"]>(() => Effect.void);
  return Effect.gen(function* () {
    const service = yield* AxisWorkHubSourceSync;
    const outcome = yield* service.sync(snapshot.sourceId, "manual");
    assert.deepEqual(outcome, { status: "synced", snapshot: newer });
    assert.equal(replace.mock.calls.length, 0);
  }).pipe(
    Effect.provide(
      makeLayer(() => Effect.succeed(snapshot), {
        get: () => Effect.sync(() => (reads++ === 0 ? null : newer)),
        replace,
      }),
    ),
  );
});

it.effect("rejects a disabled MCP source before invoking its provider", () => {
  const disabledCatalog = decodeCatalogSnapshot({
    ...catalog,
    catalog: {
      ...catalog.catalog,
      workHubSources: catalog.catalog.workHubSources.map((source) => ({
        ...source,
        enabled: false,
      })),
    },
  });
  const collect = vi.fn<NonNullable<ProviderInstance["collectWorkHubSource"]>>(() =>
    Effect.succeed(snapshot),
  );
  return Effect.gen(function* () {
    const service = yield* AxisWorkHubSourceSync;
    const failure = yield* service.sync(snapshot.sourceId, "manual").pipe(Effect.flip);
    assert.equal(failure._tag, "AxisWorkHubSourceValidationError");
    assert.equal(collect.mock.calls.length, 0);
  }).pipe(
    Effect.provide(
      makeLayer(
        collect,
        { get: () => Effect.succeed(null), replace: () => Effect.void },
        disabledCatalog,
      ),
    ),
  );
});

it.effect("rejects an MCP capability whose driver allowlist excludes the instance", () => {
  const incompatibleCatalog = decodeCatalogSnapshot({
    ...catalog,
    catalog: {
      ...catalog.catalog,
      capabilities: catalog.catalog.capabilities.map((capability) => ({
        ...capability,
        compatibleDrivers: ["claudeAgent"],
      })),
    },
  });
  const collect = vi.fn<NonNullable<ProviderInstance["collectWorkHubSource"]>>(() =>
    Effect.succeed(snapshot),
  );
  return Effect.gen(function* () {
    const service = yield* AxisWorkHubSourceSync;
    const failure = yield* service.sync(snapshot.sourceId, "manual").pipe(Effect.flip);
    assert.equal(failure._tag, "AxisWorkHubSourceValidationError");
    assert.match(failure.message, /not compatible with provider driver/u);
    assert.equal(collect.mock.calls.length, 0);
  }).pipe(
    Effect.provide(
      makeLayer(collect, { get: () => Effect.succeed(null), replace: () => Effect.void }, incompatibleCatalog),
    ),
  );
});

it.effect("keeps a cancelled waiter attached until the shared collection exits", () => {
  const started = Deferred.makeUnsafe<void>();
  const response = Deferred.makeUnsafe<AxisWorkHubCacheSnapshot>();
  const collect = vi.fn<NonNullable<ProviderInstance["collectWorkHubSource"]>>(() =>
    Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(response))),
  );
  const replace = vi.fn<AxisWorkHubCacheStore["Service"]["replace"]>(() => Effect.void);
  return Effect.gen(function* () {
    const service = yield* AxisWorkHubSourceSync;
    const first = yield* service.sync(snapshot.sourceId, "manual").pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(first);
    const second = yield* service.sync(snapshot.sourceId, "manual").pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.equal(collect.mock.calls.length, 1);
    yield* Deferred.succeed(response, snapshot);
    const outcome = yield* Fiber.join(second);
    assert.deepEqual(outcome, { status: "synced", snapshot });
    assert.equal(replace.mock.calls.length, 1);
  }).pipe(
    Effect.provide(
      makeLayer(collect, {
        get: () => Effect.succeed(null),
        replace,
      }),
    ),
  );
});

it.effect("classifies only explicit authorization failures as authorization-required", () =>
  Effect.sync(() => {
    assert.equal(
      classifyAxisWorkHubCollectionFailure("MCP returned HTTP 401 Unauthorized"),
      "authorization",
    );
    assert.equal(classifyAxisWorkHubCollectionFailure("connector timed out"), "transient");
  }),
);

it.effect("records an authorization failure without replacing the last good cache", () => {
  const recordFailure = vi.fn<AxisWorkHubCacheStore["Service"]["recordFailure"]>(() => Effect.void);
  const collect = vi.fn<NonNullable<ProviderInstance["collectWorkHubSource"]>>(() =>
    Effect.fail(
      new ProviderDriverError({
        driver: "codex",
        instanceId: "codex",
        detail: "HTTP 403 Forbidden",
      }),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* AxisWorkHubSourceSync;
    const failure = yield* service.sync(snapshot.sourceId, "manual").pipe(Effect.flip);
    assert.equal(failure._tag, "AxisWorkHubSyncError");
    assert.equal(recordFailure.mock.calls.length, 1);
    assert.equal(recordFailure.mock.calls[0]?.[1]?.kind, "authorization");
    assert.equal(recordFailure.mock.calls[0]?.[1]?.message, "HTTP 403 Forbidden");
  }).pipe(
    Effect.provide(
      makeLayer(collect, {
        get: () => Effect.succeed(snapshot),
        replace: () => Effect.void,
        recordFailure,
      }),
    ),
  );
});

it.effect("keeps the persisted snapshot through a failed read and replaces it on retry", () => {
  const recovered = decodeCacheSnapshot({
    ...snapshot,
    cursor: "recovered-cursor",
    refreshedAt: "2026-09-05T10:00:00.000Z",
    expiresAt: "2026-09-05T18:00:00.000Z",
  });
  let attempts = 0;
  const collect = vi.fn<NonNullable<ProviderInstance["collectWorkHubSource"]>>(() => {
    attempts += 1;
    return attempts === 1
      ? Effect.fail(
          new ProviderDriverError({
            driver: "codex",
            instanceId: "codex",
            detail: "HTTP 401 Unauthorized",
          }),
        )
      : Effect.succeed(recovered);
  });
  const replace = vi.fn<AxisWorkHubCacheStore["Service"]["replace"]>(() => Effect.void);
  return Effect.gen(function* () {
    const service = yield* AxisWorkHubSourceSync;
    const firstFailure = yield* service.sync(snapshot.sourceId, "manual").pipe(Effect.flip);
    assert.equal(firstFailure._tag, "AxisWorkHubSyncError");
    assert.deepEqual(replace.mock.calls, []);
    const retry = yield* service.sync(snapshot.sourceId, "manual");
    assert.deepEqual(retry, { status: "synced", snapshot: recovered });
    assert.equal(replace.mock.calls.length, 1);
    assert.deepEqual(replace.mock.calls[0]?.[0], recovered);
  }).pipe(
    Effect.provide(
      makeLayer(collect, {
        get: () => Effect.succeed(snapshot),
        replace,
        recordFailure: () => Effect.void,
      }),
    ),
  );
});

it.effect("records an invalid provider binding as a transient failure", () => {
  const recordFailure = vi.fn<AxisWorkHubCacheStore["Service"]["recordFailure"]>(() => Effect.void);
  const invalidSnapshot = decodeCacheSnapshot({ ...snapshot, sourceId: "another_source" });
  const replace = vi.fn<AxisWorkHubCacheStore["Service"]["replace"]>(() => Effect.void);
  return Effect.gen(function* () {
    const service = yield* AxisWorkHubSourceSync;
    const failure = yield* service.sync(snapshot.sourceId, "manual").pipe(Effect.flip);
    assert.equal(failure._tag, "AxisWorkHubSourceValidationError");
    assert.equal(recordFailure.mock.calls.length, 1);
    assert.equal(recordFailure.mock.calls[0]?.[1]?.kind, "transient");
    assert.equal(replace.mock.calls.length, 0);
  }).pipe(
    Effect.provide(
      makeLayer(() => Effect.succeed(invalidSnapshot), {
        get: () => Effect.succeed(snapshot),
        replace,
        recordFailure,
      }),
    ),
  );
});

it.effect("keeps the provider failure when recording its diagnostic fails", () => {
  const collect = vi.fn<NonNullable<ProviderInstance["collectWorkHubSource"]>>(() =>
    Effect.fail(
      new ProviderDriverError({
        driver: "codex",
        instanceId: "codex",
        detail: "connector timed out",
      }),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* AxisWorkHubSourceSync;
    const failure = yield* service.sync(snapshot.sourceId, "manual").pipe(Effect.flip);
    assert.equal(failure._tag, "AxisWorkHubSyncError");
    assert.equal(failure.message, "connector timed out");
  }).pipe(
    Effect.provide(
      makeLayer(collect, {
        get: () => Effect.succeed(snapshot),
        replace: () => Effect.void,
        recordFailure: () =>
          Effect.fail(
            new AxisWorkHubCachePersistenceError({ operation: "record test diagnostic" }),
          ),
      }),
    ),
  );
});

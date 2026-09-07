import {
  type AxisContextCatalogPersistenceError,
  axisProviderInstanceLocatorKey,
  type AxisWorkHubCachePersistenceError,
  type AxisWorkHubCacheSnapshot,
  type AxisWorkHubSourceId,
  AxisWorkHubSourceValidationError,
  AxisWorkHubSyncError,
  isAxisWorkHubCacheFresh,
  resolveAxisContextProviderInstances,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { AxisContextCatalogStore } from "../contexts/AxisContextCatalogStore.ts";
import { AxisWorkHubCacheStore, mergeAxisWorkHubCacheSnapshot } from "./AxisWorkHubCacheStore.ts";

export type AxisWorkHubSourceSyncError =
  | AxisContextCatalogPersistenceError
  | AxisWorkHubCachePersistenceError
  | AxisWorkHubSourceValidationError
  | AxisWorkHubSyncError;

export type AxisWorkHubSourceSyncOutcome =
  | {
      readonly status: "synced";
      readonly snapshot: AxisWorkHubCacheSnapshot;
    }
  | {
      readonly status: "skipped";
      readonly reason: "fresh-cache";
      readonly snapshot: AxisWorkHubCacheSnapshot;
    };

export class AxisWorkHubSourceSync extends Context.Service<
  AxisWorkHubSourceSync,
  {
    readonly sync: (
      sourceId: AxisWorkHubSourceId,
      trigger: "manual" | "scheduled",
    ) => Effect.Effect<AxisWorkHubSourceSyncOutcome, AxisWorkHubSourceSyncError>;
  }
>()("t3/axis/workHub/AxisWorkHubSourceSync") {}

export const make = Effect.gen(function* () {
  const catalogStore = yield* AxisContextCatalogStore;
  const cacheStore = yield* AxisWorkHubCacheStore;
  const providers = yield* ProviderInstanceRegistry;
  const serverEnvironment = yield* ServerEnvironment;
  const localEnvironmentId = yield* serverEnvironment.getEnvironmentId;
  const inFlight = new Map<
    string,
    Deferred.Deferred<AxisWorkHubSourceSyncOutcome, AxisWorkHubSourceSyncError>
  >();

  const validateSource = Effect.fn("AxisWorkHubSourceSync.validateSource")(function* (
    sourceId: AxisWorkHubSourceId,
  ) {
    const catalog = (yield* catalogStore.get).catalog;
    const source = catalog.workHubSources.find((candidate) => candidate.id === sourceId);
    if (!source) {
      return yield* new AxisWorkHubSourceValidationError({
        sourceId,
        message: "The selected Work Hub source does not exist.",
      });
    }
    if (!source.enabled) {
      return yield* new AxisWorkHubSourceValidationError({
        sourceId,
        message: "The selected Work Hub source is disabled.",
      });
    }
    if (!catalog.contexts.some((context) => context.id === source.contextId)) {
      return yield* new AxisWorkHubSourceValidationError({
        sourceId,
        message: "The selected Work Hub source belongs to an unknown Axis context.",
      });
    }
    if (source.provider.environmentId !== localEnvironmentId) {
      return yield* new AxisWorkHubSourceValidationError({
        sourceId,
        message:
          "The selected Work Hub source belongs to another environment and cannot be synced by this server.",
      });
    }

    const providerKey = axisProviderInstanceLocatorKey(source.provider);
    const accessible = resolveAxisContextProviderInstances(catalog, source.contextId).some(
      (provider) => axisProviderInstanceLocatorKey(provider) === providerKey,
    );
    if (!accessible) {
      return yield* new AxisWorkHubSourceValidationError({
        sourceId,
        message: "The selected Work Hub source's provider is not available in its Axis context.",
      });
    }

    const capability = catalog.capabilities.find(
      (candidate) => candidate.id === source.capabilityId,
    );
    const capabilityMatchesProvider =
      capability !== undefined &&
      axisProviderInstanceLocatorKey(capability.provider) === providerKey;
    if (
      !capability ||
      capability.kind !== "mcp" ||
      !capability.enabled ||
      !capabilityMatchesProvider
    ) {
      return yield* new AxisWorkHubSourceValidationError({
        sourceId,
        message: !capability
          ? "The selected Work Hub source's MCP no longer exists."
          : capability.kind !== "mcp"
            ? "The selected Work Hub source does not reference an MCP capability."
            : !capability.enabled
              ? "The selected Work Hub source's MCP capability is disabled."
              : "The selected Work Hub source's MCP belongs to another provider.",
      });
    }

    const instance = yield* providers.getInstance(source.provider.instanceId);
    if (!instance?.collectWorkHubSource) {
      return yield* new AxisWorkHubSyncError({
        sourceId,
        instanceId: source.provider.instanceId,
        message: instance
          ? `Provider '${instance.driverKind}' does not support Work Hub sync.`
          : `Provider instance '${source.provider.instanceId}' was not found.`,
      });
    }
    if (!instance.enabled) {
      return yield* new AxisWorkHubSourceValidationError({
        sourceId,
        message: "The selected Work Hub source's provider is disabled.",
      });
    }
    return { source, capability, instance, providerKey } as const;
  });

  const collect = Effect.fn("AxisWorkHubSourceSync.collect")(function* (
    sourceId: AxisWorkHubSourceId,
  ) {
    // Resolve mutable catalog grants and provider state inside the detached
    // operation so every real collection is authorized immediately before use.
    const { source, capability, instance, providerKey } = yield* validateSource(sourceId);
    const previous = yield* cacheStore.get(source.id);
    const snapshot = yield* instance.collectWorkHubSource!({
      sourceId: source.id,
      contextId: source.contextId,
      provider: source.provider,
      capabilityId: source.capabilityId,
      mcpName: capability.name,
      collectionPolicy: source.collectionPolicy,
      cacheTtlSeconds: source.cacheTtlSeconds,
      previousCursor: previous?.cursor ?? null,
      previousRefreshedAt:
        previous?.items.some((item) => item.view === "messages") === true
          ? previous.refreshedAt
          : null,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new AxisWorkHubSyncError({
            sourceId: source.id,
            instanceId: source.provider.instanceId,
            message: cause.detail || "The provider could not sync this MCP.",
          }),
      ),
    );
    const snapshotMatchesSource =
      snapshot.sourceId === source.id &&
      snapshot.contextId === source.contextId &&
      snapshot.capabilityId === source.capabilityId &&
      axisProviderInstanceLocatorKey(snapshot.provider) === providerKey;
    if (!snapshotMatchesSource) {
      return yield* new AxisWorkHubSourceValidationError({
        sourceId: source.id,
        message: "The provider returned a Work Hub snapshot for a different source binding.",
      });
    }

    const current = yield* cacheStore.get(source.id);
    // A result from an operation that escaped this process's single-flight
    // (for example, one begun before a server handoff) cannot replace newer data.
    if (current && Date.parse(current.refreshedAt) > Date.parse(snapshot.refreshedAt)) {
      return { status: "synced" as const, snapshot: current };
    }
    const merged = mergeAxisWorkHubCacheSnapshot(current, snapshot);
    yield* cacheStore.replace(merged);
    return { status: "synced" as const, snapshot: merged };
  });

  const runSingleFlight = Effect.fn("AxisWorkHubSourceSync.runSingleFlight")(function* (
    sourceId: AxisWorkHubSourceId,
  ) {
    const deferred = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const existing = inFlight.get(sourceId);
        if (existing) return existing;
        const created = Deferred.makeUnsafe<
          AxisWorkHubSourceSyncOutcome,
          AxisWorkHubSourceSyncError
        >();
        inFlight.set(sourceId, created);
        yield* collect(sourceId).pipe(
          Effect.onExit((exit) =>
            Deferred.done(created, exit).pipe(
              Effect.andThen(Effect.sync(() => inFlight.delete(sourceId))),
            ),
          ),
          Effect.forkDetach,
        );
        return created;
      }),
    );
    return yield* Deferred.await(deferred);
  });

  const sync: AxisWorkHubSourceSync["Service"]["sync"] = Effect.fn("AxisWorkHubSourceSync.sync")(
    function* (sourceId, trigger) {
      if (trigger === "scheduled") {
        // Validate first so stale schedules cannot hide revoked grants or disabled
        // capabilities merely because an old snapshot has not expired yet.
        yield* validateSource(sourceId);
        const cached = yield* cacheStore.get(sourceId);
        if (cached) {
          const now = yield* DateTime.now;
          if (isAxisWorkHubCacheFresh(cached, DateTime.toEpochMillis(now))) {
            return { status: "skipped" as const, reason: "fresh-cache" as const, snapshot: cached };
          }
        }
      }
      return yield* runSingleFlight(sourceId);
    },
  );

  return { sync } satisfies AxisWorkHubSourceSync["Service"];
});

export const layer = Layer.effect(AxisWorkHubSourceSync, make);

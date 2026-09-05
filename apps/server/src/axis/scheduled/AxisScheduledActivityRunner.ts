import * as NodeCrypto from "node:crypto";

import {
  type AxisContextCatalog,
  type AxisScheduledActivity,
  type AxisScheduledActivityDraft,
  type AxisScheduledActivityError,
  AxisScheduledActivityId,
  AxisScheduledActivityPersistenceError,
  type AxisScheduledActivityRun,
  type AxisScheduledActivitySourceRun,
  AxisScheduledActivityRunId,
  type AxisScheduledActivitySchedule,
  AxisScheduledActivityValidationError,
  AxisWorkHubSyncError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

import { AxisContextCatalogStore } from "../contexts/AxisContextCatalogStore.ts";
import {
  AxisWorkHubCacheStore,
  mergeAxisWorkHubCacheSnapshot,
} from "../workHub/AxisWorkHubCacheStore.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { AxisScheduledActivityStore } from "./AxisScheduledActivityStore.ts";

const POLL_INTERVAL = "1 minute";

const isoNow = Effect.map(DateTime.now, DateTime.formatIso);
const scheduledPersistenceError = (operation: string) => () =>
  new AxisScheduledActivityPersistenceError({ operation });

export function nextAxisScheduledActivityRunAt(
  schedule: AxisScheduledActivitySchedule,
  afterEpochMs: number,
): string {
  if (schedule.kind === "interval") {
    const anchor = Date.parse(schedule.anchorAt);
    if (anchor > afterEpochMs) return DateTime.formatIso(DateTime.makeUnsafe(anchor));
    const intervalMs = schedule.everyMinutes * 60_000;
    const intervalsElapsed = Math.floor((afterEpochMs - anchor) / intervalMs) + 1;
    return DateTime.formatIso(DateTime.makeUnsafe(anchor + intervalsElapsed * intervalMs));
  }

  const [hour, minute] = schedule.localTime.split(":").map(Number);
  const expression = `${minute} ${hour} * * ${[...new Set(schedule.daysOfWeek)].join(",")}`;
  const parsed = Cron.parse(expression, schedule.timezone);
  if (Result.isFailure(parsed)) {
    throw parsed.failure;
  }
  return Cron.next(parsed.success, afterEpochMs).toISOString();
}

function validateDraft(
  draft: AxisScheduledActivityDraft,
  catalog: AxisContextCatalog,
  localEnvironmentId: string,
): string | null {
  if (!catalog.contexts.some((context) => context.id === draft.contextId)) {
    return "The selected Axis context does not exist.";
  }
  if (new Set(draft.action.sourceIds).size !== draft.action.sourceIds.length) {
    return "A scheduled activity cannot contain the same Work Hub source more than once.";
  }
  for (const sourceId of draft.action.sourceIds) {
    const source = catalog.workHubSources.find((candidate) => candidate.id === sourceId);
    if (!source) return `Work Hub source '${sourceId}' does not exist.`;
    if (source.contextId !== draft.contextId) {
      return `Work Hub source '${sourceId}' belongs to another Axis context.`;
    }
    if (source.provider.environmentId !== localEnvironmentId) {
      return `Work Hub source '${sourceId}' belongs to another environment. Create its schedule on that environment.`;
    }
  }
  if (draft.schedule.kind === "weekly") {
    const [hour, minute] = draft.schedule.localTime.split(":").map(Number);
    const expression = `${minute} ${hour} * * ${draft.schedule.daysOfWeek.join(",")}`;
    if (Result.isFailure(Cron.parse(expression, draft.schedule.timezone))) {
      return "The scheduled activity has an invalid timezone or schedule.";
    }
  }
  return null;
}

export class AxisScheduledActivityRunner extends Context.Service<
  AxisScheduledActivityRunner,
  {
    readonly list: AxisScheduledActivityStore["Service"]["list"];
    readonly create: (
      draft: AxisScheduledActivityDraft,
    ) => Effect.Effect<AxisScheduledActivity, AxisScheduledActivityError>;
    readonly update: (
      draft: AxisScheduledActivityDraft,
    ) => Effect.Effect<AxisScheduledActivity, AxisScheduledActivityError>;
    readonly remove: AxisScheduledActivityStore["Service"]["remove"];
    readonly listRuns: AxisScheduledActivityStore["Service"]["listRuns"];
    readonly runNow: (
      id: AxisScheduledActivityId,
    ) => Effect.Effect<AxisScheduledActivityRun, AxisScheduledActivityError>;
    /** Public so tests and maintenance code can drive scheduling without sleeping. */
    readonly tick: Effect.Effect<void, never>;
  }
>()("t3/axis/scheduled/AxisScheduledActivityRunner") {}

export const make = Effect.gen(function* () {
  const store = yield* AxisScheduledActivityStore;
  const catalogStore = yield* AxisContextCatalogStore;
  const cacheStore = yield* AxisWorkHubCacheStore;
  const providers = yield* ProviderInstanceRegistry;
  const serverEnvironment = yield* ServerEnvironment;
  const localEnvironmentId = yield* serverEnvironment.getEnvironmentId;
  const activeIds = yield* Ref.make(new Set<string>());

  const normalizeDraft = Effect.fn("AxisScheduledActivityRunner.normalizeDraft")(function* (
    draft: AxisScheduledActivityDraft,
    previous?: AxisScheduledActivity,
  ) {
    const nowDateTime = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(nowDateTime);
    const now = DateTime.formatIso(nowDateTime);
    const catalog = (yield* catalogStore.get.pipe(
      Effect.mapError(scheduledPersistenceError("read context catalog")),
    )).catalog;
    const issue = validateDraft(draft, catalog, localEnvironmentId);
    if (issue) return yield* new AxisScheduledActivityValidationError({ message: issue });
    const nextRunAt = yield* Effect.try({
      try: () => nextAxisScheduledActivityRunAt(draft.schedule, nowMs),
      catch: () =>
        new AxisScheduledActivityValidationError({
          message: "The scheduled activity has an invalid timezone or schedule.",
        }),
    });
    return {
      ...draft,
      nextRunAt,
      lastRunAt: previous?.lastRunAt ?? null,
      lastRunStatus: previous?.lastRunStatus ?? null,
      lastRunMessage: previous?.lastRunMessage ?? null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    } satisfies AxisScheduledActivity;
  });

  const create: AxisScheduledActivityRunner["Service"]["create"] = Effect.fn(
    "AxisScheduledActivityRunner.create",
  )(function* (draft) {
    return yield* store.create(yield* normalizeDraft(draft));
  });

  const acquireActivity = Effect.fn("AxisScheduledActivityRunner.acquireActivity")(function* (
    id: AxisScheduledActivityId,
    message: string,
  ) {
    const acquired = yield* Ref.modify(activeIds, (active) => {
      if (active.has(id)) return [false, active] as const;
      const next = new Set(active);
      next.add(id);
      return [true, next] as const;
    });
    if (!acquired) {
      return yield* new AxisScheduledActivityValidationError({
        message,
      });
    }
  });

  const releaseActivity = (id: AxisScheduledActivityId) =>
    Ref.update(activeIds, (active) => {
      const next = new Set(active);
      next.delete(id);
      return next;
    });

  const update: AxisScheduledActivityRunner["Service"]["update"] = Effect.fn(
    "AxisScheduledActivityRunner.update",
  )(function* (draft) {
    yield* acquireActivity(
      draft.id,
      "This scheduled activity is running. Wait for it to finish before changing it.",
    );
    return yield* Effect.gen(function* () {
      const previous = yield* store.get(draft.id);
      return yield* store.update(yield* normalizeDraft(draft, previous));
    }).pipe(Effect.ensuring(releaseActivity(draft.id)));
  });

  const remove: AxisScheduledActivityRunner["Service"]["remove"] = Effect.fn(
    "AxisScheduledActivityRunner.remove",
  )(function* (id) {
    yield* acquireActivity(
      id,
      "This scheduled activity is running. Wait for it to finish before deleting it.",
    );
    return yield* store.remove(id).pipe(Effect.ensuring(releaseActivity(id)));
  });

  const runActivity = Effect.fn("AxisScheduledActivityRunner.runActivity")(function* (
    id: AxisScheduledActivityId,
    trigger: "manual" | "scheduled",
  ) {
    yield* acquireActivity(id, "This scheduled activity is already running.");

    return yield* Effect.gen(function* () {
      // Resolve only after acquiring the per-activity lock. This prevents an
      // update that raced the tick from being overwritten by a stale record.
      const activity = yield* store.get(id);
      if (trigger === "scheduled") {
        const now = yield* DateTime.now;
        if (!activity.enabled || Date.parse(activity.nextRunAt) > DateTime.toEpochMillis(now)) {
          return yield* new AxisScheduledActivityValidationError({
            message: "This scheduled activity is no longer due.",
          });
        }
      }
      const startedAt = yield* isoNow;
      const runId = AxisScheduledActivityRunId.make(NodeCrypto.randomUUID());
      const running: AxisScheduledActivityRun = {
        id: runId,
        activityId: activity.id,
        trigger,
        status: "running",
        startedAt,
        finishedAt: null,
        message: null,
        sourceResults: [],
      };
      yield* store.saveRun(running);
      const sourceResults = yield* Effect.gen(function* () {
        const catalog = (yield* catalogStore.get.pipe(
          Effect.mapError(scheduledPersistenceError("read context catalog for run")),
        )).catalog;
        return yield* Effect.forEach(
          activity.action.sourceIds,
          (sourceId): Effect.Effect<AxisScheduledActivitySourceRun> => {
            const source = catalog.workHubSources.find((candidate) => candidate.id === sourceId);
            if (!source || source.contextId !== activity.contextId || !source.enabled) {
              return Effect.succeed({
                sourceId,
                status: "skipped" as const,
                itemCount: 0,
                message: source
                  ? "The Work Hub source is disabled."
                  : "The Work Hub source no longer exists.",
              });
            }
            if (source.provider.environmentId !== localEnvironmentId) {
              return Effect.succeed({
                sourceId,
                status: "skipped" as const,
                itemCount: 0,
                message: "This Work Hub source belongs to another environment.",
              });
            }
            const capability = catalog.capabilities.find(
              (candidate) => candidate.id === source.capabilityId,
            );
            const capabilityMatchesSource =
              capability?.kind === "mcp" &&
              capability.provider.environmentId === source.provider.environmentId &&
              capability.provider.instanceId === source.provider.instanceId;
            if (!capability || !capability.enabled || !capabilityMatchesSource) {
              return Effect.succeed({
                sourceId,
                status: "skipped" as const,
                itemCount: 0,
                message: !capability
                  ? "The MCP capability no longer exists."
                  : !capability.enabled
                    ? "The MCP capability is disabled."
                    : "The MCP capability no longer matches this Work Hub source.",
              });
            }
            return Effect.gen(function* () {
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
              const previous = yield* cacheStore.get(source.id);
              const snapshot = yield* instance.collectWorkHubSource({
                sourceId: source.id,
                contextId: source.contextId,
                provider: source.provider,
                capabilityId: source.capabilityId,
                mcpName: capability.name,
                cacheTtlSeconds: source.cacheTtlSeconds,
                collectionPolicy: source.collectionPolicy,
                previousCursor: previous?.cursor ?? null,
                previousRefreshedAt:
                  previous?.items.some((item) => item.view === "messages") === true
                    ? previous.refreshedAt
                    : null,
              });
              const merged = mergeAxisWorkHubCacheSnapshot(previous, snapshot);
              yield* cacheStore.replace(merged);
              return merged;
            }).pipe(
              Effect.match({
                onFailure: (error) => ({
                  sourceId,
                  status: "failed" as const,
                  itemCount: 0,
                  message:
                    typeof error === "object" && error !== null && "message" in error
                      ? String(error.message)
                      : "The Work Hub source could not be synced.",
                }),
                onSuccess: (snapshot) => ({
                  sourceId,
                  status: "succeeded" as const,
                  itemCount: snapshot.items.length,
                  message: null,
                }),
              }),
            );
          },
          { concurrency: 2 },
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            activity.action.sourceIds.map((sourceId) => ({
              sourceId,
              status: "failed" as const,
              itemCount: 0,
              message:
                typeof error === "object" && error !== null && "message" in error
                  ? String(error.message)
                  : "The scheduled activity could not read its Axis context.",
            })),
          ),
        ),
      );

      const succeeded = sourceResults.filter((result) => result.status === "succeeded").length;
      const failed = sourceResults.length - succeeded;
      const status =
        succeeded === sourceResults.length ? "succeeded" : succeeded === 0 ? "failed" : "partial";
      const finishedAt = yield* isoNow;
      const message = `${succeeded} source${succeeded === 1 ? "" : "s"} synced; ${failed} failed or skipped.`;
      const completed: AxisScheduledActivityRun = {
        ...running,
        status,
        finishedAt,
        message,
        sourceResults,
      };
      yield* store.saveRun(completed);
      const finishedMs = Date.parse(finishedAt);
      const nextRunAt =
        trigger === "manual" && Date.parse(activity.nextRunAt) > finishedMs
          ? activity.nextRunAt
          : nextAxisScheduledActivityRunAt(activity.schedule, finishedMs);
      yield* store.update({
        ...activity,
        nextRunAt,
        lastRunAt: finishedAt,
        lastRunStatus: status,
        lastRunMessage: message,
        updatedAt: finishedAt,
      });
      return completed;
    }).pipe(Effect.ensuring(releaseActivity(id)));
  });

  const runNow: AxisScheduledActivityRunner["Service"]["runNow"] = Effect.fn(
    "AxisScheduledActivityRunner.runNow",
  )(function* (id) {
    return yield* runActivity(id, "manual");
  });

  const tick: AxisScheduledActivityRunner["Service"]["tick"] = Effect.gen(function* () {
    const now = yield* isoNow;
    const due = yield* store.listDue(now);
    yield* Effect.forEach(
      due,
      (activity) =>
        runActivity(activity.id, "scheduled").pipe(
          Effect.catch((error) =>
            Effect.logError("Axis scheduled activity failed").pipe(
              Effect.annotateLogs({ activityId: activity.id, error: String(error) }),
            ),
          ),
        ),
      { concurrency: 2, discard: true },
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("Axis scheduled activity tick failed").pipe(
        Effect.annotateLogs({ error: String(error) }),
      ),
    ),
  );

  return {
    list: store.list,
    create,
    update,
    remove,
    listRuns: store.listRuns,
    runNow,
    tick,
  } satisfies AxisScheduledActivityRunner["Service"];
});

export const layer = Layer.effect(AxisScheduledActivityRunner, make);

export const schedulerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const runner = yield* AxisScheduledActivityRunner;
    yield* runner.tick.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL)), Effect.forkScoped);
  }),
);

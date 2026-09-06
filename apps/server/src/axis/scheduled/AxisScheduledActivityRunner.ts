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
  CommandId,
  MessageId,
  resolveAxisContextProviderInstances,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Option from "effect/Option";

import { AxisContextCatalogStore } from "../contexts/AxisContextCatalogStore.ts";
import { AxisWorkHubSourceSync } from "../workHub/AxisWorkHubSourceSync.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
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
  const action = draft.action;
  if (action.kind === "workHubSync") {
    if (new Set(action.sourceIds).size !== action.sourceIds.length) {
      return "A scheduled activity cannot contain the same Work Hub source more than once.";
    }
    for (const sourceId of action.sourceIds) {
      const source = catalog.workHubSources.find((candidate) => candidate.id === sourceId);
      if (!source) return `Work Hub source '${sourceId}' does not exist.`;
      if (source.contextId !== draft.contextId) {
        return `Work Hub source '${sourceId}' belongs to another Axis context.`;
      }
      if (source.provider.environmentId !== localEnvironmentId) {
        return `Work Hub source '${sourceId}' belongs to another environment. Create its schedule on that environment.`;
      }
    }
  } else {
    if (
      action.project.environmentId !== localEnvironmentId ||
      action.provider.environmentId !== localEnvironmentId
    ) {
      return "Scheduled agent work must use a Project and provider from this environment.";
    }
    const projectBoundToContext = catalog.projectBindings.some(
      (binding) =>
        binding.contextId === draft.contextId &&
        binding.project.environmentId === action.project.environmentId &&
        binding.project.projectId === action.project.projectId,
    );
    if (!projectBoundToContext) {
      return "The selected Project is not bound to this Axis context.";
    }
    const providerAccessible = resolveAxisContextProviderInstances(catalog, draft.contextId).some(
      (provider) =>
        provider.environmentId === action.provider.environmentId &&
        provider.instanceId === action.provider.instanceId,
    );
    if (!providerAccessible) {
      return "The selected provider is not available to this Axis context.";
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
    readonly recoverInterruptedRuns: Effect.Effect<number, AxisScheduledActivityPersistenceError>;
  }
>()("t3/axis/scheduled/AxisScheduledActivityRunner") {}

export const make = Effect.gen(function* () {
  const store = yield* AxisScheduledActivityStore;
  const catalogStore = yield* AxisContextCatalogStore;
  const workHubSourceSync = yield* AxisWorkHubSourceSync;
  const providers = yield* ProviderInstanceRegistry;
  const serverEnvironment = yield* ServerEnvironment;
  const orchestration = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
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
    if (draft.action.kind === "agentTurn") {
      const project = yield* projections
        .getProjectShellById(draft.action.project.projectId)
        .pipe(Effect.mapError(scheduledPersistenceError("read scheduled activity Project")));
      if (Option.isNone(project)) {
        return yield* new AxisScheduledActivityValidationError({
          message: "The selected Project does not exist in this environment.",
        });
      }
      const provider = yield* providers.getInstance(draft.action.provider.instanceId);
      if (!provider?.enabled) {
        return yield* new AxisScheduledActivityValidationError({
          message: provider
            ? "The selected provider is disabled."
            : "The selected provider does not exist in this environment.",
        });
      }
    }
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

  const launchAgentTurn = Effect.fn("AxisScheduledActivityRunner.launchAgentTurn")(function* (
    activity: AxisScheduledActivity & { readonly action: { readonly kind: "agentTurn" } },
  ) {
    // Revalidate mutable Axis grants and T3 targets immediately before
    // dispatch. A valid schedule must not outlive a revoked provider grant or
    // a removed context-to-Project binding.
    const catalog = (yield* catalogStore.get.pipe(
      Effect.mapError(scheduledPersistenceError("read context catalog for agent run")),
    )).catalog;
    const issue = validateDraft(activity, catalog, localEnvironmentId);
    if (issue) return yield* new AxisScheduledActivityValidationError({ message: issue });
    const project = yield* projections
      .getProjectShellById(activity.action.project.projectId)
      .pipe(Effect.mapError(scheduledPersistenceError("read scheduled activity Project for run")));
    if (Option.isNone(project)) {
      return yield* new AxisScheduledActivityValidationError({
        message: "The selected Project no longer exists in this environment.",
      });
    }
    const provider = yield* providers.getInstance(activity.action.provider.instanceId);
    if (!provider?.enabled) {
      return yield* new AxisScheduledActivityValidationError({
        message: provider
          ? "The selected provider is disabled."
          : "The selected provider no longer exists in this environment.",
      });
    }

    const threadId = ThreadId.make(NodeCrypto.randomUUID());
    const modelSelection = {
      instanceId: activity.action.provider.instanceId,
      model: activity.action.model,
    } as const;
    const createdAt = yield* isoNow;
    let created = false;
    return yield* Effect.gen(function* () {
      yield* orchestration.dispatch({
        type: "thread.create",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId,
        projectId: activity.action.project.projectId,
        title: activity.action.title,
        modelSelection,
        runtimeMode: activity.action.runtimeMode,
        interactionMode: activity.action.interactionMode,
        branch: null,
        worktreePath: null,
        createdAt,
      });
      created = true;
      yield* orchestration.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId,
        message: {
          messageId: MessageId.make(NodeCrypto.randomUUID()),
          role: "user",
          text: activity.action.prompt,
          attachments: [],
        },
        modelSelection,
        runtimeMode: activity.action.runtimeMode,
        interactionMode: activity.action.interactionMode,
        createdAt,
      });
      return threadId;
    }).pipe(
      Effect.catch((error) =>
        created
          ? orchestration
              .dispatch({
                type: "thread.delete",
                commandId: CommandId.make(NodeCrypto.randomUUID()),
                threadId,
              })
              .pipe(
                Effect.catchCause((cleanupCause) =>
                  Effect.logWarning("Failed to clean up scheduled activity Thread", {
                    activityId: activity.id,
                    threadId,
                    cleanupCause,
                  }),
                ),
                Effect.andThen(Effect.fail(error)),
              )
          : Effect.fail(error),
      ),
    );
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
        threadId: null,
      };
      yield* store.saveRun(running);
      if (activity.action.kind === "agentTurn") {
        const outcome = yield* launchAgentTurn(
          activity as AxisScheduledActivity & { readonly action: { readonly kind: "agentTurn" } },
        ).pipe(
          Effect.match({
            onFailure: (error) => ({
              status: "failed" as const,
              threadId: null,
              message:
                typeof error === "object" && error !== null && "message" in error
                  ? String(error.message)
                  : "The scheduled agent work could not be started.",
            }),
            onSuccess: (threadId) => ({
              status: "succeeded" as const,
              threadId,
              message: `Started Thread '${threadId}'.`,
            }),
          }),
        );
        const finishedAt = yield* isoNow;
        const completed: AxisScheduledActivityRun = {
          ...running,
          ...outcome,
          finishedAt,
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
          lastRunStatus: outcome.status,
          lastRunMessage: outcome.message,
          updatedAt: finishedAt,
        });
        return completed;
      }
      const sourceIds = activity.action.sourceIds;
      const sourceResults = yield* Effect.forEach(
        sourceIds,
        (sourceId): Effect.Effect<AxisScheduledActivitySourceRun> =>
          workHubSourceSync.sync(sourceId, trigger).pipe(
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
              onSuccess: (outcome) => ({
                sourceId,
                status:
                  outcome.status === "skipped" ? ("skipped" as const) : ("succeeded" as const),
                itemCount: outcome.snapshot.items.length,
                message:
                  outcome.status === "skipped"
                    ? "Cached data is still fresh; Run now forces a sync."
                    : null,
              }),
            }),
          ),
        { concurrency: 2 },
      );

      const succeeded = sourceResults.filter((result) => result.status === "succeeded").length;
      const failed = sourceResults.filter((result) => result.status === "failed").length;
      const skipped = sourceResults.length - succeeded - failed;
      const status =
        failed === 0 ? "succeeded" : failed === sourceResults.length ? "failed" : "partial";
      const finishedAt = yield* isoNow;
      const message = `${succeeded} source${succeeded === 1 ? "" : "s"} synced; ${skipped} skipped; ${failed} failed.`;
      const completed: AxisScheduledActivityRun = {
        ...running,
        status,
        finishedAt,
        message,
        sourceResults,
        threadId: null,
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
    recoverInterruptedRuns: isoNow.pipe(Effect.flatMap(store.recoverInterruptedRuns)),
  } satisfies AxisScheduledActivityRunner["Service"];
});

export const layer = Layer.effect(AxisScheduledActivityRunner, make);

export const schedulerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const runner = yield* AxisScheduledActivityRunner;
    yield* runner.recoverInterruptedRuns.pipe(
      Effect.tap((count) =>
        count > 0
          ? Effect.logWarning("Recovered interrupted Axis scheduled activity runs", { count })
          : Effect.void,
      ),
      Effect.catch((error) =>
        Effect.logError("Failed to recover interrupted Axis scheduled activity runs", { error }),
      ),
    );
    yield* runner.tick.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL)), Effect.forkScoped);
  }),
);

import { AxisContextCatalogStore } from "../contexts/AxisContextCatalogStore.ts";
import * as AxisLearningEngine from "./AxisLearningEngine.ts";
import * as AxisLearningService from "./AxisLearningService.ts";
import * as AxisLearningStore from "./AxisLearningStore.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "../../provider/Services/ProviderService.ts";
import {
  AxisLearningEvidenceId,
  type AxisLearningProvenance,
  type AxisLearningEvidence as AxisLearningEvidenceType,
  type AxisLearningScope,
} from "../../../../../packages/contracts/src/axisLearning.ts";
import type {
  AxisContextCatalogSnapshot,
  AxisContextId,
  AxisProjectLocator,
  AxisProviderInstanceLocator,
} from "../../../../../packages/contracts/src/axisContext.ts";
import type { AxisContextProjectScope } from "../../../../../packages/contracts/src/axisProjectProfile.ts";
import type { AxisWorkHubCacheSnapshot } from "../../../../../packages/contracts/src/axisWorkHub.ts";
import type { ProviderRuntimeEvent } from "../../../../../packages/contracts/src/providerRuntime.ts";
import { CommandId, type ProjectId } from "../../../../../packages/contracts/src/baseSchemas.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";
import * as ServerSettings from "../../serverSettings.ts";

const MAX_AUTOMATIC_BATCH = 32;
const AUTOMATIC_EVIDENCE_DAYS = 30;

export type AxisLearningAutomaticSourceKind = Extract<
  AxisLearningProvenance["sourceKind"],
  "thread-turn" | "review" | "ticket" | "skill" | "workspace-change" | "work-hub"
>;

export interface AxisLearningAutomaticObservation {
  readonly sourceKind: AxisLearningAutomaticSourceKind;
  readonly sourceId: string;
  readonly summary: string;
  readonly provider?: AxisProviderInstanceLocator;
  readonly observedAt?: string;
}

export interface AxisLearningWorkspaceObservation {
  readonly cwd: string;
  readonly sourceKind?: AxisLearningAutomaticSourceKind;
  readonly sourceId: string;
  readonly summary: string;
  readonly relativePath?: string;
}

const projectKey = (project: AxisProjectLocator) =>
  `${project.environmentId}\u0000${project.projectId}`;
const scopeKey = (scope: AxisContextProjectScope) =>
  `${scope.contextId}\u0000${projectKey(scope.project)}`;

const boundedText = (value: string, max: number) => {
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
};

const observationDigest = (observation: AxisLearningAutomaticObservation) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        sourceKind: observation.sourceKind,
        sourceId: observation.sourceId,
        summary: observation.summary,
      }),
      "utf8",
    )
    .digest("hex");

/** Prioritize every pending record while retaining recent records as comparison context. */
export function buildAutomaticEvidenceBatch(
  pending: ReadonlyArray<AxisLearningEvidenceType>,
  recent: ReadonlyArray<AxisLearningEvidenceType>,
): {
  readonly pending: ReadonlyArray<AxisLearningEvidenceType>;
  readonly batch: ReadonlyArray<AxisLearningEvidenceType>;
} {
  const pendingBatch = pending
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, MAX_AUTOMATIC_BATCH);
  const pendingIds = new Set(pendingBatch.map((evidence) => evidence.id));
  const recentContext = recent
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
    .filter((evidence) => !pendingIds.has(evidence.id))
    .slice(0, MAX_AUTOMATIC_BATCH - pendingBatch.length);
  return { pending: pendingBatch, batch: [...pendingBatch, ...recentContext] };
}

const sameProject = (left: AxisProjectLocator, right: AxisProjectLocator) =>
  left.environmentId === right.environmentId && left.projectId === right.projectId;

const contextsForProject = (
  snapshot: AxisContextCatalogSnapshot,
  project: AxisProjectLocator,
): ReadonlyArray<AxisContextProjectScope> =>
  snapshot.catalog.projectBindings
    .filter((binding) => sameProject(binding.project, project))
    .map((binding) => ({ contextId: binding.contextId, project: binding.project }));

const contextsForContext = (
  snapshot: AxisContextCatalogSnapshot,
  contextId: AxisContextId,
): ReadonlyArray<AxisContextProjectScope> =>
  snapshot.catalog.projectBindings
    .filter((binding) => binding.contextId === contextId)
    .map((binding) => ({ contextId: binding.contextId, project: binding.project }));

const compactTurnSummary = (
  event: Extract<ProviderRuntimeEvent, { readonly type: "turn.completed" | "turn.aborted" }>,
  title: string,
  recentMessages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
) => {
  const outcome = event.type === "turn.aborted" ? "aborted" : event.payload.state;
  const reason =
    event.type === "turn.aborted"
      ? event.payload.reason
      : (event.payload.errorMessage ?? event.payload.stopReason ?? "none");
  const messages = recentMessages
    .map((message) => `${message.role}: ${boundedText(message.text, 520)}`)
    .join(" | ");
  return boundedText(
    `Turn finished in project thread '${title}'. Outcome: ${outcome}. Reason: ${reason}. ${messages}`,
    1_950,
  );
};

export class AxisLearningAutomaticWorker extends Context.Service<
  AxisLearningAutomaticWorker,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly schedule: (scope: AxisLearningScope | undefined) => Effect.Effect<void>;
    readonly observe: (
      scope: AxisContextProjectScope,
      observation: AxisLearningAutomaticObservation,
    ) => Effect.Effect<void>;
    readonly observeProject: (
      projectId: ProjectId,
      observation: AxisLearningAutomaticObservation,
    ) => Effect.Effect<void>;
    readonly observeContext: (
      contextId: AxisContextId,
      observation: AxisLearningAutomaticObservation,
    ) => Effect.Effect<void>;
    readonly observeWorkspace: (input: AxisLearningWorkspaceObservation) => Effect.Effect<void>;
    readonly observeWorkHub: (snapshot: AxisWorkHubCacheSnapshot) => Effect.Effect<void>;
  }
>()("t3/axis/learning/AxisLearningAutomaticWorker") {}

export const make = Effect.gen(function* () {
  const learning = yield* AxisLearningStore.AxisLearningStore;
  const learningService = yield* AxisLearningService.AxisLearningService;
  const learningEngine = yield* AxisLearningEngine.AxisLearningEngine;
  const catalogStore = yield* AxisContextCatalogStore;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providers = yield* ProviderService.ProviderService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment;
  const running = yield* Ref.make<ReadonlyMap<string, boolean>>(new Map());

  const available = () => learningEngine.status.availability === "available";

  const drainScope = Effect.fn("AxisLearningAutomaticWorker.drainScope")(function* (
    scope: AxisContextProjectScope,
  ) {
    const key = scopeKey(scope);
    while (true) {
      const pending = yield* learning.listPendingAutomaticEvidence(scope.contextId, scope).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("automatic Axis Learning could not read evidence", {
            scope: key,
            cause,
          }),
        ),
        Effect.orElseSucceed(() => []),
      );
      if (pending.length === 0) {
        return;
      }
      // The pending records trigger the run, while the recent window gives Hermes
      // enough sequence context to compare a correction with the problem that
      // preceded it. Only pending records are marked after the run, so a later
      // observation can still be compared with this history.
      const recent = yield* learning.listEvidence(scope.contextId, scope).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("automatic Axis Learning could not read recent evidence", {
            scope: key,
            cause,
          }),
        ),
        Effect.orElseSucceed(() => []),
      );
      const { pending: pendingBatch, batch } = buildAutomaticEvidenceBatch(pending, recent);

      const result = yield* learningService
        .requestImprovements({
          scope,
          evidenceIds: batch.map((evidence) => evidence.id),
          commandId: CommandId.make(`axis-learning-auto-${NodeCrypto.randomUUID()}`),
          deadlineMs: 45_000,
        })
        .pipe(
          Effect.tap((run) =>
            run.status === "proposals"
              ? Effect.logInfo("automatic Axis Learning proposals generated", {
                  scope: key,
                  count: run.proposals.length,
                })
              : Effect.void,
          ),
          Effect.tapError((cause) =>
            Effect.logWarning("automatic Axis Learning run failed", { scope: key, cause }),
          ),
          Effect.orElseSucceed(() => null),
        );

      if (result === null || result.status === "unavailable") {
        return;
      }
      yield* DateTime.now.pipe(
        Effect.map(DateTime.formatIso),
        Effect.flatMap((analyzedAt) =>
          learning.markAutomaticEvidenceAnalyzed(
            scope,
            pendingBatch.map((evidence) => evidence.id),
            analyzedAt,
          ),
        ),
        Effect.tapError((cause) =>
          Effect.logWarning("automatic Axis Learning could not mark evidence", {
            scope: key,
            cause,
          }),
        ),
        Effect.ignore,
      );
    }
  });

  const takePendingSignal = (scope: AxisContextProjectScope) => {
    const key = scopeKey(scope);
    return Ref.modify(running, (current) => {
      if (current.get(key) === true) {
        return [true, new Map(current).set(key, false)];
      }
      const next = new Map(current);
      next.delete(key);
      return [false, next];
    });
  };

  const runScope = Effect.fn("AxisLearningAutomaticWorker.runScope")(function* (
    scope: AxisContextProjectScope,
  ) {
    let continueRunning = true;
    while (continueRunning) {
      yield* drainScope(scope);
      continueRunning = yield* takePendingSignal(scope);
    }
  });

  const startScope: (scope: AxisContextProjectScope) => Effect.Effect<void> = (scope) =>
    Effect.gen(function* () {
      const shouldStart = yield* Ref.modify(running, (current) => {
        if (current.has(scopeKey(scope))) {
          return [false, new Map(current).set(scopeKey(scope), true)];
        }
        return [true, new Map(current).set(scopeKey(scope), false)];
      });
      if (!shouldStart) return;
      yield* runScope(scope).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("automatic Axis Learning worker stopped", {
            scope: scopeKey(scope),
            cause,
          }),
        ),
        Effect.ensuring(
          Ref.update(running, (current) => {
            const result = new Map(current);
            result.delete(scopeKey(scope));
            return result;
          }),
        ),
        Effect.forkDetach,
      );
    });

  const schedule = (scope: AxisLearningScope | undefined): Effect.Effect<void> => {
    if (!available() || scope?.project === undefined) return Effect.void;
    return startScope({ contextId: scope.contextId, project: scope.project });
  };

  const record = (scope: AxisContextProjectScope, observation: AxisLearningAutomaticObservation) =>
    Effect.gen(function* () {
      const createdAt = yield* DateTime.now;
      const digest = observationDigest(observation);
      yield* learning
        .recordEvidence({
          id: AxisLearningEvidenceId.make(`axis-auto-${digest}`),
          provenance: {
            contextId: scope.contextId,
            scope,
            sourceKind: observation.sourceKind,
            sourceId: boundedText(observation.sourceId, 512),
            ...(observation.provider === undefined ? {} : { provider: observation.provider }),
            observedAt: observation.observedAt ?? DateTime.formatIso(createdAt),
            fingerprint: `sha256:${digest}`,
          },
          summary: boundedText(observation.summary, 2_000),
          createdAt: DateTime.formatIso(createdAt),
          expiresAt: DateTime.formatIso(DateTime.add(createdAt, { days: AUTOMATIC_EVIDENCE_DAYS })),
        })
        .pipe(
          Effect.tap((saved) => schedule(saved.provenance.scope)),
          Effect.catch((cause) =>
            Effect.logWarning("automatic Axis Learning could not record observation", {
              scope: scopeKey(scope),
              sourceId: observation.sourceId,
              cause,
            }),
          ),
        );
    });

  const observe = (scope: AxisContextProjectScope, observation: AxisLearningAutomaticObservation) =>
    record(scope, observation);

  const catalog = catalogStore.get.pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("automatic Axis Learning could not read catalog", { cause }),
    ),
    Effect.option,
  );

  const observeProject = (projectId: ProjectId, observation: AxisLearningAutomaticObservation) =>
    Effect.gen(function* () {
      const environmentId = yield* environment.getEnvironmentId;
      const snapshot = yield* catalog;
      if (Option.isNone(snapshot)) return;
      yield* Effect.forEach(
        contextsForProject(snapshot.value, { environmentId, projectId }),
        (scope) => observe(scope, observation),
        { discard: true },
      );
    });

  const observeContext = (
    contextId: AxisContextId,
    observation: AxisLearningAutomaticObservation,
  ) =>
    Effect.gen(function* () {
      const snapshot = yield* catalog;
      if (Option.isNone(snapshot)) return;
      yield* Effect.forEach(
        contextsForContext(snapshot.value, contextId),
        (scope) => observe(scope, observation),
        { discard: true },
      );
    });

  const observeWorkspace = (input: AxisLearningWorkspaceObservation) =>
    Effect.gen(function* () {
      const project = yield* projections.getActiveProjectByWorkspaceRoot(input.cwd).pipe(
        Effect.tapError(Effect.logWarning),
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isNone(project)) return;
      const relativePath = input.relativePath?.replaceAll("\\", "/") ?? "";
      const sourceKind =
        input.sourceKind ??
        (/(?:^|\/)(?:\.axis-tools\/skills|(?:\.agents|\.claude|\.cursor|\.gemini|\.grok|\.agent)\/skills)\//u.test(
          relativePath,
        )
          ? "skill"
          : "workspace-change");
      yield* observeProject(project.value.id, {
        sourceKind,
        sourceId: input.sourceId,
        summary: `${input.summary}${relativePath ? ` Path: ${relativePath}.` : ""}`,
      });
    });

  const observeWorkHub = (snapshot: AxisWorkHubCacheSnapshot) =>
    observeContext(snapshot.contextId, {
      sourceKind: "work-hub",
      sourceId: `work-hub:${snapshot.sourceId}:${snapshot.refreshedAt}`,
      summary: `Work Hub source '${snapshot.sourceId}' synchronized with ${snapshot.items.length} items.`,
      provider: snapshot.provider,
      observedAt: snapshot.refreshedAt,
    });

  const observeTurn = Effect.fn("AxisLearningAutomaticWorker.observeTurn")(function* (
    event: Extract<ProviderRuntimeEvent, { readonly type: "turn.completed" | "turn.aborted" }>,
  ) {
    const shell = yield* projections.getThreadShellById(event.threadId).pipe(
      Effect.tapError(Effect.logWarning),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(shell) || shell.value.projectId === null) return;
    const catalogSnapshot = yield* catalog;
    if (Option.isNone(catalogSnapshot)) return;
    const environmentId = yield* environment.getEnvironmentId;
    const scopes = contextsForProject(catalogSnapshot.value, {
      environmentId,
      projectId: shell.value.projectId,
    });
    if (scopes.length === 0) return;
    const detail = yield* projections
      .getThreadDetailSnapshot(event.threadId, { turnLimit: 1 })
      .pipe(
        Effect.tapError(Effect.logWarning),
        Effect.orElseSucceed(() => Option.none()),
      );
    const recentMessages = Option.isSome(detail)
      ? detail.value.thread.messages
          .filter((message) => message.role === "user" || message.role === "assistant")
          .slice(-3)
          .map((message) => ({ role: message.role, text: message.text }))
      : [];
    const summary = compactTurnSummary(event, shell.value.title, recentMessages);
    const provider: AxisProviderInstanceLocator = {
      environmentId,
      instanceId: event.providerInstanceId ?? shell.value.modelSelection.instanceId,
    };
    yield* Effect.forEach(
      scopes,
      (scope) =>
        observe(scope, {
          sourceKind: "thread-turn",
          sourceId: `provider-event:${event.eventId}`,
          summary,
          provider,
          observedAt: event.createdAt,
        }),
      { discard: true },
    );
  });

  const start = () =>
    Effect.gen(function* () {
      const scheduleAll = Effect.gen(function* () {
        if (!available()) return;
        const snapshot = yield* catalog;
        if (Option.isSome(snapshot)) {
          yield* Effect.forEach(
            snapshot.value.catalog.projectBindings,
            (binding) => startScope({ contextId: binding.contextId, project: binding.project }),
            { discard: true },
          );
        }
      });
      yield* scheduleAll;
      yield* serverSettings.streamChanges.pipe(
        Stream.runForEach(() => scheduleAll),
        Effect.catchCause((cause) =>
          Effect.logWarning("automatic Axis Learning settings watcher stopped", { cause }),
        ),
        Effect.forkScoped,
      );
      yield* providers.streamEvents.pipe(
        Stream.filter(
          (
            event,
          ): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }> =>
            event.type === "turn.completed" || event.type === "turn.aborted",
        ),
        Stream.runForEach((event) => observeTurn(event)),
        Effect.catchCause((cause) =>
          Effect.logWarning("automatic Axis Learning provider event stream stopped", { cause }),
        ),
        Effect.forkScoped,
      );
    });

  return {
    start,
    schedule,
    observe,
    observeProject,
    observeContext,
    observeWorkspace,
    observeWorkHub,
  };
});

export const layer = Layer.effect(AxisLearningAutomaticWorker, make);

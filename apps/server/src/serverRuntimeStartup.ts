import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ModelSelection,
  type OrchestrationProjectShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { ensureAxisChatsProject } from "./axis/chats/AxisChatsStartup.ts";
import { isAxisChatsProject } from "./axis/chats/AxisChats.ts";
import { AxisContextCatalogStore } from "./axis/contexts/AxisContextCatalogStore.ts";
import { AxisEffectiveContext } from "./axis/projects/AxisEffectiveContext.ts";
import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationReactor from "./orchestration/Services/OrchestrationReactor.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as ProviderSessionReaper from "./provider/Services/ProviderSessionReaper.ts";
import { forkParked } from "./serverActivation.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import {
  formatHeadlessServeOutput,
  formatHostForUrl,
  isWildcardHost,
  issueHeadlessServeAccessInfo,
} from "./startupAccess.ts";

export class ServerRuntimeStartupError extends Schema.TaggedErrorClass<ServerRuntimeStartupError>()(
  "ServerRuntimeStartupError",
  {
    mode: ServerConfig.RuntimeMode,
    host: Schema.NullOr(Schema.String),
    port: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Server runtime startup failed before command readiness.";
  }
}

export class ServerRuntimeStartup extends Context.Service<
  ServerRuntimeStartup,
  {
    readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
    readonly markHttpListening: Effect.Effect<void>;
    readonly markRunningProviderSessionsForContinuation: Effect.Effect<
      ReadonlyArray<ThreadId>,
      ServerUpdateThreadContinuationError
    >;
    readonly clearProviderSessionContinuationMarkers: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<void, ServerUpdateThreadContinuationError>;
    readonly enqueueCommand: <A, E>(
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
  }
>()("t3/serverRuntimeStartup") {}

interface QueuedCommand {
  readonly run: Effect.Effect<void, never>;
}

type CommandReadinessState = "pending" | "ready" | ServerRuntimeStartupError;

interface CommandGate {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly signalCommandReady: Effect.Effect<void>;
  readonly failCommandReady: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
  readonly enqueueCommand: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
}

const settleQueuedCommand = <A, E>(deferred: Deferred.Deferred<A, E>, exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? Deferred.succeed(deferred, exit.value)
    : Deferred.failCause(deferred, exit.cause);

export const makeCommandGate = Effect.gen(function* () {
  const commandReady = yield* Deferred.make<void, ServerRuntimeStartupError>();
  const commandQueue = yield* Queue.unbounded<QueuedCommand>();
  const commandReadinessState = yield* Ref.make<CommandReadinessState>("pending");

  const commandWorker = Effect.forever(
    Queue.take(commandQueue).pipe(Effect.flatMap((command) => command.run)),
  );
  yield* Effect.forkScoped(commandWorker);

  return {
    awaitCommandReady: Deferred.await(commandReady),
    signalCommandReady: Effect.gen(function* () {
      yield* Ref.set(commandReadinessState, "ready");
      yield* Deferred.succeed(commandReady, undefined).pipe(Effect.orDie);
    }),
    failCommandReady: (error) =>
      Effect.gen(function* () {
        yield* Ref.set(commandReadinessState, error);
        yield* Deferred.fail(commandReady, error).pipe(Effect.orDie);
      }),
    enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const readinessState = yield* Ref.get(commandReadinessState);
        if (readinessState === "ready") {
          return yield* effect;
        }
        if (readinessState !== "pending") {
          return yield* readinessState;
        }

        const result = yield* Deferred.make<A, E | ServerRuntimeStartupError>();
        yield* Queue.offer(commandQueue, {
          run: Deferred.await(commandReady).pipe(
            Effect.flatMap(() => effect),
            Effect.exit,
            Effect.flatMap((exit) => settleQueuedCommand(result, exit)),
          ),
        });
        return yield* Deferred.await(result);
      }),
  } satisfies CommandGate;
});

export const recordStartupHeartbeat = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const { threadCount, projectCount } = yield* projectionSnapshotQuery.getCounts().pipe(
    Effect.catch((cause) =>
      Effect.logWarning("failed to gather startup projection counts for telemetry", {
        cause,
      }).pipe(
        Effect.as({
          threadCount: 0,
          projectCount: 0,
        }),
      ),
    ),
  );

  yield* analytics.record("server.boot.heartbeat", {
    threadCount,
    projectCount,
  });
});

export const launchStartupHeartbeat = recordStartupHeartbeat.pipe(
  Effect.annotateSpans({ "startup.phase": "heartbeat.record" }),
  Effect.withSpan("server.startup.heartbeat.record"),
  Effect.ignoreCause({ log: true }),
  Effect.forkScoped,
  Effect.asVoid,
);

export const getAutoBootstrapThreadModelSelection = (): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: DEFAULT_MODEL,
});

export const resolveWelcomeBase = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const segments = serverConfig.cwd.split(/[/\\]/).filter(Boolean);
  const projectName = segments[segments.length - 1] ?? "project";

  return {
    cwd: serverConfig.cwd,
    projectName,
  } as const;
});

export const resolveAutoBootstrapWelcomeTargets = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const path = yield* Path.Path;

  let bootstrapProjectId: ProjectId | undefined;
  let bootstrapThreadId: ThreadId | undefined;

  if (serverConfig.autoBootstrapProjectFromCwd) {
    yield* Effect.gen(function* () {
      const existingProject = yield* projectionReadModelQuery.getActiveProjectByWorkspaceRoot(
        serverConfig.cwd,
      );
      let nextProjectId: ProjectId;
      let nextThreadModelSelection: ModelSelection;

      if (Option.isNone(existingProject)) {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        nextProjectId = ProjectId.make(yield* randomUUID);
        const bootstrapProjectTitle = path.basename(serverConfig.cwd) || "project";
        nextThreadModelSelection = getAutoBootstrapThreadModelSelection();
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.make(yield* randomUUID),
          projectId: nextProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: serverConfig.cwd,
          createdAt,
        });
      } else {
        nextProjectId = existingProject.value.id;
        nextThreadModelSelection =
          existingProject.value.defaultModelSelection ?? getAutoBootstrapThreadModelSelection();
      }

      const existingThreadId =
        yield* projectionReadModelQuery.getFirstActiveThreadIdByProjectId(nextProjectId);
      if (Option.isNone(existingThreadId)) {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const createdThreadId = ThreadId.make(yield* randomUUID);
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(yield* randomUUID),
          threadId: createdThreadId,
          projectId: nextProjectId,
          title: "New thread",
          modelSelection: nextThreadModelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = createdThreadId;
      } else {
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = existingThreadId.value;
      }
    });
  }

  return {
    ...(bootstrapProjectId ? { bootstrapProjectId } : {}),
    ...(bootstrapThreadId ? { bootstrapThreadId } : {}),
  } as const;
});

const resolveStartupBrowserTarget = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const localUrl = `http://localhost:${serverConfig.port}`;
  const bindUrl =
    serverConfig.host && !isWildcardHost(serverConfig.host)
      ? `http://${formatHostForUrl(serverConfig.host)}:${serverConfig.port}`
      : localUrl;
  const baseTarget = serverConfig.devUrl?.toString() ?? bindUrl;
  return yield* Effect.succeed(serverConfig.mode === "desktop" ? baseTarget : undefined).pipe(
    Effect.flatMap((target) =>
      target ? Effect.succeed(target) : serverAuth.issueStartupPairingUrl(baseTarget),
    ),
  );
});

const maybeOpenBrowser = (target: string) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    if (serverConfig.noBrowser) {
      return;
    }
    const externalLauncher = yield* ExternalLauncher.ExternalLauncher;

    yield* externalLauncher.launchBrowser(target).pipe(
      Effect.catch(() =>
        Effect.logInfo("browser auto-open unavailable", {
          hint: `Open ${target} in your browser.`,
        }),
      ),
    );
  });

const runStartupPhase = <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.annotateSpans({ "startup.phase": phase }),
    Effect.withSpan(`server.startup.${phase}`),
  );

const ORPHANED_PROVIDER_SESSION_ERROR =
  "Provider session did not survive a server restart. Send a new message to continue.";
const SERVER_UPDATE_CONTINUATION_KEY = "continueAfterServerUpdate";
const CONTINUATION_EFFECT_PAYLOAD_KEY = "axisContinuationEffect";
const SERVER_UPDATE_CONTINUATION_PROMPT = "Continue where you left off.";
const AXIS_CONTEXT_CONTINUATION_ERROR =
  "Could not continue this thread because its Axis project context changed or was revoked. Send a new message to continue.";
const UNKNOWN_PROVIDER_CONTINUATION_ERROR =
  "Could not continue this thread because the provider effect is unknown after the server restart. Send a new message to continue.";

class ProviderSessionContinuationError extends Schema.TaggedErrorClass<ProviderSessionContinuationError>()(
  "ProviderSessionContinuationError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Could not continue thread '${this.threadId}': the provider instance is missing.`;
  }
}

class AxisContinuationContextError extends Schema.TaggedErrorClass<AxisContinuationContextError>()(
  "AxisContinuationContextError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return AXIS_CONTEXT_CONTINUATION_ERROR;
  }
}

export class ServerUpdateThreadContinuationError extends Schema.TaggedErrorClass<ServerUpdateThreadContinuationError>()(
  "ServerUpdateThreadContinuationError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not prepare running threads to continue after the update.";
  }
}

function hasServerUpdateContinuationMarker(
  runtimePayload: unknown,
): runtimePayload is Record<string, unknown> {
  return (
    runtimePayload !== null &&
    typeof runtimePayload === "object" &&
    !Array.isArray(runtimePayload) &&
    SERVER_UPDATE_CONTINUATION_KEY in runtimePayload
  );
}

function readRuntimePayload(runtimePayload: unknown): Record<string, unknown> {
  return runtimePayload !== null &&
    typeof runtimePayload === "object" &&
    !Array.isArray(runtimePayload)
    ? (runtimePayload as Record<string, unknown>)
    : {};
}

const compareAndSetBinding = (
  directory: ProviderSessionDirectory.ProviderSessionDirectory["Service"],
  expected: ProviderSessionDirectory.ProviderRuntimeBinding,
  next: ProviderSessionDirectory.ProviderRuntimeBinding,
) => {
  const compareAndSet = directory.compareAndSet;
  if (compareAndSet === undefined) {
    // Custom legacy directories predate optimistic concurrency. Keep their
    // non-continuation behavior working; the production SQLite directory has
    // compareAndSet and never takes this branch for restart recovery.
    return directory.upsert(next).pipe(Effect.as(true));
  }
  const versionedExpected = expected as ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata;
  if (typeof versionedExpected.lastSeenAt !== "string") return Effect.succeed(false);
  return compareAndSet({ expected: versionedExpected, next });
};

interface PersistedContinuationEffect {
  readonly key: string;
  readonly status: "prepared" | "pending" | "unknown" | "accepted";
  readonly providerInstanceId: ProviderInstanceId;
  readonly driverKind: string;
  readonly axisContextDigest?: string | undefined;
  readonly turnId?: TurnId;
}

function readPersistedContinuationEffect(
  runtimePayload: unknown,
): PersistedContinuationEffect | undefined {
  const raw = readRuntimePayload(runtimePayload)[CONTINUATION_EFFECT_PAYLOAD_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const effect = raw as Record<string, unknown>;
  if (
    typeof effect.key !== "string" ||
    (effect.status !== "prepared" &&
      effect.status !== "pending" &&
      effect.status !== "unknown" &&
      effect.status !== "accepted") ||
    typeof effect.providerInstanceId !== "string" ||
    typeof effect.driverKind !== "string"
  ) {
    return undefined;
  }
  return {
    key: effect.key,
    status: effect.status,
    providerInstanceId: ProviderInstanceId.make(effect.providerInstanceId),
    driverKind: effect.driverKind,
    ...(typeof effect.axisContextDigest === "string"
      ? { axisContextDigest: effect.axisContextDigest }
      : {}),
    ...(typeof effect.turnId === "string" ? { turnId: TurnId.make(effect.turnId) } : {}),
  };
}

const continuationEffectKey = (threadId: ThreadId, turnId: TurnId): string =>
  `server-update:${String(threadId)}:${String(turnId)}`;

const isServerUpdateThreadContinuationError = Schema.is(ServerUpdateThreadContinuationError);
const isAxisContinuationContextError = Schema.is(AxisContinuationContextError);

const readPersistedAxisContextDigest = (runtimePayload: unknown): string | undefined => {
  const value = readRuntimePayload(runtimePayload).axisContextDigest;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const readPersistedProviderSessionModel = (runtimePayload: unknown): string | undefined => {
  const value = readRuntimePayload(runtimePayload).model;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

/**
 * A restart may happen after a project binding, provider grant, or learned
 * version changed. Re-resolve the context before replaying the continuation;
 * the digest persisted with the interrupted turn is the evidence that the
 * provider session saw the same authoritative context.
 */
export const revalidateAxisContinuationContext = Effect.fn("revalidateAxisContinuationContext")(
  function* (input: {
    readonly projectId: ProjectId | null;
    readonly session: {
      readonly providerInstanceId: ProviderInstanceId | undefined;
      readonly model: string | undefined;
    };
    readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding;
  }) {
    if (input.projectId === null || isAxisChatsProject(input.projectId)) {
      return true;
    }
    const catalogStore = yield* Effect.serviceOption(AxisContextCatalogStore);
    const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
    if (Option.isNone(catalogStore) || Option.isNone(environment)) {
      // Older runtimes do not have Axis services and must retain their legacy
      // project continuation behavior.
      return readPersistedAxisContextDigest(input.binding.runtimePayload) === undefined;
    }

    const environmentExit = yield* Effect.exit(environment.value.getEnvironmentId);
    if (Exit.isFailure(environmentExit)) return false;
    const catalogExit = yield* Effect.exit(catalogStore.value.get);
    if (Exit.isFailure(catalogExit)) return false;
    const projectBindings = catalogExit.value.catalog.projectBindings.filter(
      (candidate) =>
        candidate.project.environmentId === environmentExit.value &&
        candidate.project.projectId === input.projectId,
    );
    const expectedDigest = readPersistedAxisContextDigest(input.binding.runtimePayload);
    if (expectedDigest === undefined) {
      // A currently bound project identifies an Axis session even when an
      // interrupted turn failed before its digest was persisted. An unbound
      // project remains a pre-Axis T3 session and follows the legacy path.
      return projectBindings.length === 0;
    }
    const effectiveContext = yield* Effect.serviceOption(AxisEffectiveContext);
    if (Option.isNone(effectiveContext)) return false;

    const providerInstanceId = input.binding.providerInstanceId;
    if (
      providerInstanceId === undefined ||
      input.session.providerInstanceId === undefined ||
      input.session.providerInstanceId !== providerInstanceId
    ) {
      return false;
    }

    if (projectBindings.length !== 1) {
      return false;
    }
    const projectBinding = projectBindings[0];
    if (projectBinding === undefined) {
      return false;
    }
    const providerService = yield* ProviderService.ProviderService;
    const providerInfoExit = yield* Effect.exit(
      providerService.getInstanceInfo(providerInstanceId),
    );
    if (Exit.isFailure(providerInfoExit)) {
      return false;
    }
    const providerInfo = providerInfoExit.value;
    if (providerInfo.driverKind !== input.binding.provider) {
      return false;
    }
    const resultExit = yield* Effect.exit(
      effectiveContext.value.resolve({
        caller: { environmentId: environmentExit.value, contextId: projectBinding.contextId },
        scope: {
          contextId: projectBinding.contextId,
          project: { environmentId: environmentExit.value, projectId: input.projectId },
        },
        provider: { environmentId: environmentExit.value, instanceId: providerInstanceId },
        driver: providerInfo.driverKind,
        ...(input.session.model === undefined ? {} : { model: input.session.model }),
        step: "execute",
        paths: [],
      }),
    );
    return Exit.isSuccess(resultExit) && resultExit.value.digest === expectedDigest;
  },
);

const isPreparedContinuationBinding = (input: {
  readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding;
  readonly expected: ProviderSessionDirectory.ProviderRuntimeBinding;
  readonly continuationTurnId: TurnId | null;
}): boolean => {
  if (
    input.binding.provider !== input.expected.provider ||
    input.binding.providerInstanceId !== input.expected.providerInstanceId ||
    readPersistedAxisContextDigest(input.binding.runtimePayload) !==
      readPersistedAxisContextDigest(input.expected.runtimePayload)
  ) {
    return false;
  }
  const payload = readRuntimePayload(input.binding.runtimePayload);
  return (
    input.continuationTurnId !== null &&
    readServerUpdateContinuationTurnId(input.binding.runtimePayload) === input.continuationTurnId &&
    payload.activeTurnId === null &&
    payload.continueAfterServerUpdatePrepared === true
  );
};

function readServerUpdateContinuationTurnId(runtimePayload: unknown): TurnId | null {
  if (!hasServerUpdateContinuationMarker(runtimePayload)) {
    return null;
  }
  const value = runtimePayload[SERVER_UPDATE_CONTINUATION_KEY];
  return typeof value === "string" && value.length > 0 ? TurnId.make(value) : null;
}

const toServerUpdateThreadContinuationError = (cause: unknown) =>
  isServerUpdateThreadContinuationError(cause)
    ? cause
    : new ServerUpdateThreadContinuationError({ cause });

export const markRunningProviderSessionsForContinuation = Effect.gen(function* () {
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const { threads } = yield* query.getCommandReadModel();
  const running = threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.session?.status === "running" &&
      thread.session.activeTurnId !== null,
  );

  const marked: ThreadId[] = [];
  return yield* Effect.gen(function* () {
    for (const thread of running) {
      const activeTurnId = thread.session?.activeTurnId;
      if (activeTurnId === null || activeTurnId === undefined) {
        continue;
      }
      const binding = yield* directory.getBinding(thread.id);
      if (Option.isNone(binding)) {
        continue;
      }
      if (binding.value.resumeCursor === null || binding.value.resumeCursor === undefined) {
        continue;
      }
      // Without CAS, shutdown must not write over a concurrently replaced session.
      if (directory.compareAndSet === undefined) continue;
      const changed = yield* compareAndSetBinding(directory, binding.value, {
        ...binding.value,
        runtimePayload: {
          ...readRuntimePayload(binding.value.runtimePayload),
          [SERVER_UPDATE_CONTINUATION_KEY]: activeTurnId,
          continueAfterServerUpdatePrepared: null,
        },
      });
      if (changed) marked.push(thread.id);
    }
    return marked;
  }).pipe(
    Effect.catchCause((cause) =>
      clearProviderSessionContinuationMarkers(marked).pipe(Effect.andThen(Effect.failCause(cause))),
    ),
  );
}).pipe(Effect.mapError(toServerUpdateThreadContinuationError));

const clearContinuationMarkers = (
  directory: ProviderSessionDirectory.ProviderSessionDirectory["Service"],
  threadIds: ReadonlyArray<ThreadId>,
) =>
  Effect.forEach(
    threadIds,
    (threadId) =>
      directory.getBinding(threadId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (binding) =>
              directory.compareAndSet === undefined
                ? Effect.void
                : compareAndSetBinding(directory, binding, {
                    ...binding,
                    runtimePayload: {
                      ...readRuntimePayload(binding.runtimePayload),
                      [SERVER_UPDATE_CONTINUATION_KEY]: null,
                      continueAfterServerUpdatePrepared: null,
                    },
                  }).pipe(Effect.asVoid),
          }),
        ),
      ),
    { concurrency: "unbounded", discard: true },
  );

export const clearProviderSessionContinuationMarkers = (threadIds: ReadonlyArray<ThreadId>) =>
  Effect.gen(function* () {
    const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
    yield* clearContinuationMarkers(directory, threadIds);
  }).pipe(Effect.mapError(toServerUpdateThreadContinuationError));

export const reconcileProviderSessions = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const providerService = yield* ProviderService.ProviderService;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settings = yield* ServerSettings.ServerSettingsService;
  const continueAfterRestart = yield* settings.getSettings.pipe(
    Effect.map((value) => value.continueThreadsAfterServerUpdate),
    Effect.catch((cause) =>
      Effect.logWarning("could not read restart continuation preference", { cause }).pipe(
        Effect.as(false),
      ),
    ),
  );

  const liveThreadIds = new Set(
    (yield* providerService.listSessions()).map((session) => session.threadId),
  );
  const { threads } = yield* query.getCommandReadModel();
  // Provider startup can report ready before the continuation is submitted.
  // Find those markers in one read rather than querying every idle thread.
  const preparedThreadIds = new Set(
    (yield* directory.listBindings().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("failed to read prepared provider continuations", { cause }).pipe(
          Effect.andThen(
            Effect.forEach(
              threads.filter(
                (thread) => thread.session?.status === "ready" && !liveThreadIds.has(thread.id),
              ),
              (thread) =>
                directory.getBinding(thread.id).pipe(Effect.orElseSucceed(() => Option.none())),
            ),
          ),
          Effect.map((bindings) =>
            bindings.flatMap((binding) => (Option.isSome(binding) ? [binding.value] : [])),
          ),
        ),
      ),
    ))
      .filter(
        (binding) =>
          readServerUpdateContinuationTurnId(binding.runtimePayload) !== null &&
          readRuntimePayload(binding.runtimePayload).activeTurnId === null &&
          readRuntimePayload(binding.runtimePayload).continueAfterServerUpdatePrepared === true,
      )
      .map((binding) => binding.threadId),
  );
  const orphanedThreads = threads.filter(
    (thread) =>
      thread.session !== null &&
      (thread.session.status === "starting" ||
        thread.session.status === "running" ||
        thread.session.activeTurnId !== null ||
        (thread.session.status === "ready" && preparedThreadIds.has(thread.id))) &&
      !liveThreadIds.has(thread.id),
  );

  for (const thread of orphanedThreads) {
    const session = thread.session;
    if (session === null) {
      continue;
    }
    const binding = yield* directory.getBinding(thread.id).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("failed to read orphaned provider session directory binding", {
              threadId: thread.id,
              cause,
            }).pipe(Effect.as(Option.none())),
      ),
    );
    const continuationMarkerPresent =
      Option.isSome(binding) && hasServerUpdateContinuationMarker(binding.value.runtimePayload);
    const continuationTurnId = Option.isSome(binding)
      ? readServerUpdateContinuationTurnId(binding.value.runtimePayload)
      : null;
    const continuationMarked =
      continuationTurnId !== null &&
      (session.activeTurnId === null || continuationTurnId === session.activeTurnId) &&
      Option.isSome(binding) &&
      (readRuntimePayload(binding.value.runtimePayload).activeTurnId == null ||
        readRuntimePayload(binding.value.runtimePayload).activeTurnId === continuationTurnId);
    const preparedWhileReady =
      session.status === "ready" &&
      session.activeTurnId === null &&
      continuationMarked &&
      Option.isSome(binding) &&
      readRuntimePayload(binding.value.runtimePayload).activeTurnId === null &&
      readRuntimePayload(binding.value.runtimePayload).continueAfterServerUpdatePrepared === true;
    // Abrupt shutdowns cannot write an update marker. Require both durable
    // records to agree on an unfinished turn before recovering one implicitly.
    const interruptedByRestart =
      continueAfterRestart &&
      session.status === "running" &&
      session.activeTurnId !== null &&
      Option.isSome(binding) &&
      binding.value.status === "running" &&
      binding.value.resumeCursor != null &&
      readRuntimePayload(binding.value.runtimePayload).activeTurnId === session.activeTurnId;
    const sourceTurnId = session.activeTurnId ?? continuationTurnId;
    const storedEffect = Option.isSome(binding)
      ? readPersistedContinuationEffect(binding.value.runtimePayload)
      : undefined;
    // Payload merges in older versions may have retained a previous turn's
    // claim. It is not admission/acceptance evidence for the current generation.
    const currentEffect =
      sourceTurnId !== null && storedEffect?.key === continuationEffectKey(thread.id, sourceTurnId)
        ? storedEffect
        : undefined;
    const effectMatchesBinding =
      Option.isSome(binding) &&
      currentEffect !== undefined &&
      currentEffect.providerInstanceId === binding.value.providerInstanceId &&
      currentEffect.driverKind === binding.value.provider &&
      currentEffect.axisContextDigest ===
        readPersistedAxisContextDigest(binding.value.runtimePayload);
    const acceptedAwaitingProjection =
      Option.isSome(binding) &&
      effectMatchesBinding &&
      currentEffect?.status === "accepted" &&
      currentEffect.turnId !== undefined &&
      readRuntimePayload(binding.value.runtimePayload).activeTurnId === currentEffect.turnId;
    const settleAsError = (lastError: string) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          if (Option.isSome(binding)) {
            const effect = currentEffect;
            if (effect !== undefined && providerService.settleContinuation !== undefined) {
              // The service owns the continuation lease. It re-reads the
              // current binding and updates that value, so a newer binding is
              // never restored from this stale reconciliation snapshot.
              yield* providerService.settleContinuation({
                threadId: thread.id,
                providerInstanceId: binding.value.providerInstanceId ?? effect.providerInstanceId,
                driverKind: binding.value.provider,
                ...(effect.axisContextDigest === undefined
                  ? {}
                  : { axisContextDigest: effect.axisContextDigest }),
                idempotencyKey: effect.key,
                outcome: "unknown",
              });
            } else {
              const latest =
                directory.compareAndSet === undefined &&
                (effect !== undefined || interruptedByRestart)
                  ? yield* directory.getBinding(thread.id)
                  : Option.some(binding.value);
              if (Option.isSome(latest)) {
                const latestEffect = readPersistedContinuationEffect(latest.value.runtimePayload);
                // An error may stop only the snapshot this reconciliation
                // owned; a replacement is another writer's session.
                yield* compareAndSetBinding(directory, latest.value, {
                  ...latest.value,
                  status: "stopped",
                  runtimePayload: {
                    ...readRuntimePayload(latest.value.runtimePayload),
                    activeTurnId: null,
                    ...(latestEffect === undefined
                      ? {}
                      : {
                          [CONTINUATION_EFFECT_PAYLOAD_KEY]: {
                            ...latestEffect,
                            status: "unknown",
                          },
                        }),
                    ...(continuationMarkerPresent || interruptedByRestart
                      ? {
                          [SERVER_UPDATE_CONTINUATION_KEY]: null,
                          continueAfterServerUpdatePrepared: null,
                        }
                      : {}),
                  },
                });
              }
            }
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning(
                  "failed to reconcile orphaned provider session directory binding",
                  { threadId: thread.id, cause },
                ),
          ),
        );

        yield* Effect.gen(function* () {
          const reconciledAt = DateTime.formatIso(yield* DateTime.now);
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId: thread.id,
            session: {
              ...session,
              status: "error",
              activeTurnId: null,
              lastError,
              updatedAt: reconciledAt,
            },
            createdAt: reconciledAt,
          });
        }).pipe(
          Effect.retry({ times: 1 }),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("failed to settle orphaned provider session projection", {
                  threadId: thread.id,
                  cause,
                }),
          ),
        );
      });

    if (
      Option.isSome(binding) &&
      (continuationMarked || interruptedByRestart || acceptedAwaitingProjection) &&
      (session.status === "running" || session.status === "starting" || preparedWhileReady) &&
      binding.value.resumeCursor != null &&
      thread.archivedAt === null &&
      thread.deletedAt === null
    ) {
      const persistedEffect = currentEffect;
      if (persistedEffect !== undefined && !effectMatchesBinding) {
        yield* settleAsError(UNKNOWN_PROVIDER_CONTINUATION_ERROR);
        continue;
      }
      if (persistedEffect?.status === "pending" || persistedEffect?.status === "unknown") {
        yield* Effect.logWarning("blocking automatic continuation with unknown provider effect", {
          threadId: thread.id,
          idempotencyKey: persistedEffect.key,
          status: persistedEffect.status,
        });
        yield* settleAsError(UNKNOWN_PROVIDER_CONTINUATION_ERROR);
        continue;
      }
      if (persistedEffect?.status === "accepted") {
        if (
          persistedEffect.turnId === undefined ||
          providerService.settleContinuation === undefined
        ) {
          yield* settleAsError(UNKNOWN_PROVIDER_CONTINUATION_ERROR);
          continue;
        }
        const settled = yield* providerService
          .settleContinuation({
            threadId: thread.id,
            providerInstanceId: persistedEffect.providerInstanceId,
            driverKind: binding.value.provider,
            ...(persistedEffect.axisContextDigest === undefined
              ? {}
              : { axisContextDigest: persistedEffect.axisContextDigest }),
            idempotencyKey: persistedEffect.key,
            outcome: "accepted",
            turnId: persistedEffect.turnId,
          })
          .pipe(Effect.orElseSucceed(() => false));
        if (!settled) {
          yield* settleAsError(UNKNOWN_PROVIDER_CONTINUATION_ERROR);
          continue;
        }
        const reconciledAt = DateTime.formatIso(yield* DateTime.now);
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(yield* crypto.randomUUIDv4),
          threadId: thread.id,
          session: {
            ...session,
            status: "running",
            activeTurnId: persistedEffect.turnId,
            lastError: null,
            updatedAt: reconciledAt,
          },
          createdAt: reconciledAt,
        });
        continue;
      }
      const continuationTurnIdForPreparation = session.activeTurnId ?? continuationTurnId;
      if (continuationTurnIdForPreparation === null) {
        yield* settleAsError(UNKNOWN_PROVIDER_CONTINUATION_ERROR);
        continue;
      }
      const continuationKey = continuationEffectKey(thread.id, continuationTurnIdForPreparation);
      const axisContextCurrent = yield* revalidateAxisContinuationContext({
        projectId: thread.projectId,
        session: {
          providerInstanceId: session.providerInstanceId,
          model: readPersistedProviderSessionModel(binding.value.runtimePayload),
        },
        binding: binding.value,
      }).pipe(Effect.orElseSucceed(() => false));
      if (!axisContextCurrent) {
        yield* Effect.logWarning("refusing provider session continuation with stale Axis context", {
          threadId: thread.id,
        });
        yield* settleAsError(AXIS_CONTEXT_CONTINUATION_ERROR);
        continue;
      }
      const prepared = yield* Effect.gen(function* () {
        const preparedBinding = {
          ...binding.value,
          status: "starting",
          runtimePayload: {
            ...readRuntimePayload(binding.value.runtimePayload),
            // Keep recovery durable if this process also exits before sending.
            [SERVER_UPDATE_CONTINUATION_KEY]: session.activeTurnId ?? continuationTurnId,
            continueAfterServerUpdatePrepared: true,
            activeTurnId: null,
            [CONTINUATION_EFFECT_PAYLOAD_KEY]: {
              key: continuationKey,
              status: "prepared",
              providerInstanceId: binding.value.providerInstanceId,
              driverKind: binding.value.provider,
              ...(readPersistedAxisContextDigest(binding.value.runtimePayload) === undefined
                ? {}
                : {
                    axisContextDigest: readPersistedAxisContextDigest(binding.value.runtimePayload),
                  }),
            },
          },
        } satisfies ProviderSessionDirectory.ProviderRuntimeBinding;
        const admitted = yield* compareAndSetBinding(directory, binding.value, preparedBinding);
        if (!admitted) return false;
        const resumedAt = DateTime.formatIso(yield* DateTime.now);
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(yield* crypto.randomUUIDv4),
          threadId: thread.id,
          session: {
            ...session,
            status: "starting",
            activeTurnId: null,
            lastError: null,
            updatedAt: resumedAt,
          },
          createdAt: resumedAt,
        });
        return true;
      }).pipe(Effect.retry({ times: 1 }), Effect.exit);
      if (Exit.isFailure(prepared)) {
        if (Cause.hasInterrupts(prepared.cause)) {
          return yield* Effect.failCause(prepared.cause);
        }
        yield* Effect.logWarning("failed to prepare provider session continuation", {
          threadId: thread.id,
          cause: prepared.cause,
        });
        yield* settleAsError(ORPHANED_PROVIDER_SESSION_ERROR);
        continue;
      }
      if (!prepared.value) {
        yield* Effect.logWarning("provider continuation preparation lost its binding CAS", {
          threadId: thread.id,
        });
        yield* settleAsError(AXIS_CONTEXT_CONTINUATION_ERROR);
        continue;
      }

      const continuationTurnIdForFence = session.activeTurnId ?? continuationTurnId;
      yield* forkParked(
        Effect.gen(function* () {
          const continuation = Effect.gen(function* () {
            const providerInstanceId = binding.value.providerInstanceId;
            if (providerInstanceId === undefined) {
              return yield* new ProviderSessionContinuationError({
                threadId: thread.id,
              });
            }
            const capabilities = yield* providerService.getCapabilities(providerInstanceId);
            // The preparation writes above intentionally do not authorize the
            // provider call. Re-read the durable binding after capability
            // resolution and make context validation the final effect before
            // sendTurn. A changed marker, provider instance, or digest means
            // another actor won the continuation race.
            const latestBindingExit = yield* Effect.exit(directory.getBinding(thread.id));
            if (Exit.isFailure(latestBindingExit)) {
              return yield* new AxisContinuationContextError({ threadId: thread.id });
            }
            const latestBinding = latestBindingExit.value;
            if (
              Option.isNone(latestBinding) ||
              !isPreparedContinuationBinding({
                binding: latestBinding.value,
                expected: binding.value,
                continuationTurnId: continuationTurnIdForFence,
              })
            ) {
              return yield* new AxisContinuationContextError({ threadId: thread.id });
            }
            const latestAxisContextCurrent = yield* revalidateAxisContinuationContext({
              projectId: thread.projectId,
              session: {
                providerInstanceId: session.providerInstanceId,
                model: readPersistedProviderSessionModel(latestBinding.value.runtimePayload),
              },
              binding: latestBinding.value,
            }).pipe(Effect.orElseSucceed(() => false));
            if (!latestAxisContextCurrent) {
              return yield* new AxisContinuationContextError({ threadId: thread.id });
            }
            yield* providerService.sendTurn({
              threadId: thread.id,
              ...(capabilities.promptlessTurnContinuation === true
                ? { continuation: true }
                : { input: SERVER_UPDATE_CONTINUATION_PROMPT }),
              interactionMode: thread.interactionMode,
              continuationFence: {
                providerInstanceId,
                driverKind: latestBinding.value.provider,
                ...(readPersistedAxisContextDigest(latestBinding.value.runtimePayload) === undefined
                  ? {}
                  : {
                      axisContextDigest: readPersistedAxisContextDigest(
                        latestBinding.value.runtimePayload,
                      ),
                    }),
                idempotencyKey: continuationKey,
              },
            });
          });
          const continuationExit = yield* Effect.exit(continuation);
          if (Exit.isSuccess(continuationExit) || Cause.hasInterrupts(continuationExit.cause)) {
            if (Exit.isSuccess(continuationExit)) {
              yield* clearContinuationMarkers(directory, [thread.id]).pipe(
                Effect.uninterruptible,
                Effect.catchCause((cause) =>
                  Effect.logWarning("failed to clear completed provider session continuation", {
                    threadId: thread.id,
                    cause,
                  }),
                ),
              );
            }
            return;
          }
          yield* Effect.logWarning("failed to continue provider session after server restart", {
            threadId: thread.id,
            cause: continuationExit.cause,
          });
          const failure = continuationExit.cause.reasons.find(Cause.isFailReason)?.error;
          yield* settleAsError(
            failure !== undefined && isAxisContinuationContextError(failure)
              ? AXIS_CONTEXT_CONTINUATION_ERROR
              : "Could not continue this thread after the server restart. Send a new message to continue.",
          ).pipe(Effect.ignoreCause);
        }),
      );
      continue;
    }

    yield* settleAsError(ORPHANED_PROVIDER_SESSION_ERROR);
  }
}).pipe(
  Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.logWarning("provider session startup reconciliation failed", { cause }),
  ),
);

interface StartupOptions {
  readonly activate?: Effect.Effect<void>;
  readonly awaitAuxiliaryParked?: Effect.Effect<void>;
  readonly abort?: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
}

export const autoPullProjects = Effect.fn("autoPullProjects")(function* (
  projects: ReadonlyArray<OrchestrationProjectShell>,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const workspaceRoots = [
    ...new Set(
      projects
        .filter((project) => project.autoPull === true && !isAxisChatsProject(project.id))
        .map((project) => project.workspaceRoot),
    ),
  ];

  yield* Effect.forEach(
    workspaceRoots,
    (cwd) =>
      Effect.gen(function* () {
        const status = yield* git.statusDetails(cwd);
        if (
          !status.isRepo ||
          !status.isDefaultBranch ||
          !status.hasUpstream ||
          status.hasWorkingTreeChanges ||
          status.aheadCount > 0
        ) {
          yield* Effect.logDebug("Skipped automatic project pull", {
            cwd,
            reason: !status.isRepo
              ? "not-a-repository"
              : !status.isDefaultBranch
                ? "not-on-default-branch"
                : !status.hasUpstream
                  ? "no-upstream"
                  : status.hasWorkingTreeChanges
                    ? "working-tree-changes"
                    : "local-commits",
          });
          return;
        }

        if (status.behindCount <= 0) return;

        const result = yield* git.pullCurrentBranch(cwd);
        yield* Effect.logDebug("Automatic project pull completed", {
          cwd,
          status: result.status,
          refName: result.refName,
        });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Automatic project pull failed", {
            cwd,
            cause,
          }),
        ),
      ),
    { concurrency: 4, discard: true },
  );
});

export const make = (options?: StartupOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const keybindings = yield* Keybindings.Keybindings;
    const orchestrationReactor = yield* OrchestrationReactor.OrchestrationReactor;
    const providerSessionReaper = yield* ProviderSessionReaper.ProviderSessionReaper;
    const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const providerSessionDirectory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
    const crypto = yield* Crypto.Crypto;
    const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;

    const commandGate = yield* makeCommandGate;
    const httpListening = yield* Deferred.make<void>();
    const reactorScope = yield* Scope.make("sequential");

    const syncAutoPullProjects = projectionSnapshotQuery.getShellSnapshot().pipe(
      Effect.flatMap((snapshot) => autoPullProjects(snapshot.projects)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to load projects for automatic pull", { cause }),
      ),
    );

    yield* Effect.addFinalizer(() => Scope.close(reactorScope, Exit.void));

    const startup = Effect.gen(function* () {
      yield* Effect.logDebug("startup phase: starting keybindings runtime");
      yield* runStartupPhase(
        "keybindings.start",
        keybindings.start.pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to start keybindings runtime", {
              path: error.configPath,
              detail: error.detail,
              cause: error.cause,
            }),
          ),
        ),
      );

      yield* Effect.logDebug("startup phase: starting server settings runtime");
      yield* runStartupPhase(
        "settings.start",
        serverSettings.start.pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to start server settings runtime", {
              path: error.settingsPath,
              operation: error.operation,
              providerInstanceId: error.providerInstanceId,
              environmentVariable: error.environmentVariable,
              cause: error.cause,
            }),
          ),
        ),
      );

      yield* Effect.logDebug("startup phase: parking orchestration roots at activation");
      yield* runStartupPhase(
        "reactors.start",
        Effect.gen(function* () {
          yield* orchestrationReactor.start().pipe(Scope.provide(reactorScope));
          yield* providerSessionReaper.start().pipe(Scope.provide(reactorScope));
        }),
      );

      yield* runStartupPhase("chats.ensure-project", ensureAxisChatsProject);

      yield* runStartupPhase("provider-sessions.reconcile", reconcileProviderSessions);

      yield* Effect.logDebug("startup phase: syncing clean projects");
      yield* runStartupPhase("projects.auto-pull", syncAutoPullProjects);

      const welcomeBase = yield* resolveWelcomeBase;
      const environment = yield* serverEnvironment.getDescriptor;
      yield* Effect.logDebug("startup phase: preparing welcome payload");

      if (serverConfig.autoBootstrapProjectFromCwd) {
        yield* forkParked(
          runStartupPhase(
            "welcome.autobootstrap",
            Effect.gen(function* () {
              const bootstrapTargets = yield* resolveAutoBootstrapWelcomeTargets.pipe(
                Effect.provideService(Crypto.Crypto, crypto),
              );
              if (!bootstrapTargets.bootstrapProjectId && !bootstrapTargets.bootstrapThreadId) {
                return;
              }

              yield* Effect.logDebug("startup phase: publishing bootstrapped welcome event", {
                environmentId: environment.environmentId,
                cwd: welcomeBase.cwd,
                projectName: welcomeBase.projectName,
                bootstrapProjectId: bootstrapTargets.bootstrapProjectId,
                bootstrapThreadId: bootstrapTargets.bootstrapThreadId,
              });
              yield* lifecycleEvents.publish({
                version: 1,
                type: "welcome",
                payload: {
                  environment,
                  ...welcomeBase,
                  ...bootstrapTargets,
                },
              });
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("startup auto-bootstrap welcome failed", {
                  cause,
                }),
              ),
            ),
          ),
        );
      }

      yield* forkParked(
        Effect.gen(function* () {
          yield* Effect.logDebug("startup phase: recording startup heartbeat");
          yield* recordStartupHeartbeat.pipe(
            Effect.annotateSpans({ "startup.phase": "heartbeat.record" }),
            Effect.withSpan("server.startup.heartbeat.record"),
            Effect.ignoreCause({ log: true }),
          );
          if (serverConfig.startupPresentation === "headless") {
            const accessInfo = yield* issueHeadlessServeAccessInfo();
            yield* runStartupPhase(
              "headless.output",
              Console.log(formatHeadlessServeOutput(accessInfo)),
            );
          } else {
            const startupBrowserTarget = yield* resolveStartupBrowserTarget;
            if (serverConfig.mode !== "desktop") {
              yield* Effect.logInfo(
                "Authentication required. Open T3 Code using the pairing URL.",
              ).pipe(Effect.annotateLogs({ pairingUrl: startupBrowserTarget }));
            }
            yield* runStartupPhase("browser.open", maybeOpenBrowser(startupBrowserTarget));
          }
        }),
      );

      yield* Effect.logDebug("startup phase: waiting for http listener");
      yield* runStartupPhase("http.wait", Deferred.await(httpListening));
      yield* runStartupPhase(
        "auxiliary-roots.parked",
        options?.awaitAuxiliaryParked ?? Effect.void,
      );

      // This is the prepared boundary. Every dependency has been acquired and
      // every runtime root has confirmed that it is parked before this request.
      const updateOutcome = yield* launcher.prepareTrial;
      yield* runStartupPhase(
        "welcome.publish",
        lifecycleEvents.publish({
          version: 1,
          type: "welcome",
          payload: { environment, ...welcomeBase },
        }),
      );
      yield* options?.activate ?? Effect.void;

      yield* Effect.logDebug("Accepting commands");
      yield* commandGate.signalCommandReady;
      yield* runStartupPhase(
        "ready.publish",
        lifecycleEvents.publish({
          version: 1,
          type: "ready",
          payload: {
            at: DateTime.formatIso(yield* DateTime.now),
            environment,
            ...(updateOutcome === undefined ? {} : { updateOutcome }),
          },
        }),
      );
      yield* Effect.logDebug("startup phase: complete");
    }).pipe(
      Effect.annotateSpans({
        "server.mode": serverConfig.mode,
        "server.port": serverConfig.port,
        "server.host": serverConfig.host ?? "default",
      }),
      Effect.withSpan("server.startup", { kind: "server", root: true }),
    );

    yield* Effect.forkScoped(
      Effect.exit(startup).pipe(
        Effect.flatMap((startupExit) => {
          if (Exit.isSuccess(startupExit)) return Effect.void;
          const error = new ServerRuntimeStartupError({
            mode: serverConfig.mode,
            host: serverConfig.host ?? null,
            port: serverConfig.port,
            cause: startupExit.cause,
          });
          return Effect.logError("server runtime startup failed", {
            cause: startupExit.cause,
          }).pipe(
            Effect.andThen(commandGate.failCommandReady(error)),
            Effect.andThen(options?.abort?.(error) ?? Effect.void),
          );
        }),
      ),
    );

    return {
      awaitCommandReady: commandGate.awaitCommandReady,
      markHttpListening: Deferred.succeed(httpListening, undefined),
      markRunningProviderSessionsForContinuation: markRunningProviderSessionsForContinuation.pipe(
        Effect.provideService(
          ProjectionSnapshotQuery.ProjectionSnapshotQuery,
          projectionSnapshotQuery,
        ),
        Effect.provideService(
          ProviderSessionDirectory.ProviderSessionDirectory,
          providerSessionDirectory,
        ),
      ),
      clearProviderSessionContinuationMarkers: (threadIds) =>
        clearProviderSessionContinuationMarkers(threadIds).pipe(
          Effect.provideService(
            ProviderSessionDirectory.ProviderSessionDirectory,
            providerSessionDirectory,
          ),
        ),
      enqueueCommand: commandGate.enqueueCommand,
    } satisfies ServerRuntimeStartup["Service"];
  });

export const layerWithOptions = (options?: StartupOptions) =>
  Layer.effect(ServerRuntimeStartup, make(options));

export const layer = layerWithOptions();

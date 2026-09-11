import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_MODEL,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as AxisContextCatalogStore from "./axis/contexts/AxisContextCatalogStore.ts";
import { AXIS_CHATS_PROJECT_ID } from "./axis/chats/AxisChats.ts";
import * as AxisEffectiveContext from "./axis/projects/AxisEffectiveContext.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

it("uses the canonical Codex default for the auto-bootstrapped welcome thread", () => {
  assert.deepStrictEqual(ServerRuntimeStartup.getAutoBootstrapThreadModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect("revalidates the Axis digest before a restart continuation", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project-restart");
    const threadId = ThreadId.make("thread-restart");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const session = {
      threadId,
      provider: "codex",
      providerInstanceId,
      model: "gpt-5",
    } as never;
    const binding = {
      threadId,
      provider: "codex",
      providerInstanceId,
      runtimePayload: { axisContextDigest: "digest-current" },
    } as never;
    const catalog = {
      revision: 2,
      catalog: {
        contexts: [],
        projectBindings: [
          { contextId: "company", project: { environmentId: "env", projectId } },
        ],
        providerOwnerships: [],
        providerAccessGrants: [],
        capabilities: [],
        workHubSources: [],
      },
      updatedAt: "2026-09-10T00:00:00.000Z",
    };
    const providerService = {
      getInstanceInfo: () =>
        Effect.succeed({
          instanceId: providerInstanceId,
          driverKind: "codex",
          displayName: undefined,
          enabled: true,
          continuationIdentity: "native",
        }),
    } as never;
    const resolve = (input: unknown) => {
      assert.equal((input as { readonly step: string }).step, "execute");
      return Effect.succeed({ digest: "digest-current" } as never);
    };
    const check = (projectBindings: ReadonlyArray<unknown>) =>
      ServerRuntimeStartup.revalidateAxisContinuationContext({
        projectId,
        session,
        binding,
      }).pipe(
        Effect.provideService(AxisContextCatalogStore.AxisContextCatalogStore, {
          get: Effect.succeed({ ...catalog, catalog: { ...catalog.catalog, projectBindings } }),
        } as never),
        Effect.provideService(AxisEffectiveContext.AxisEffectiveContext, { resolve } as never),
        Effect.provideService(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed("env"),
        } as never),
        Effect.provideService(ProviderService.ProviderService, providerService),
      );

    assert.equal(yield* check(catalog.catalog.projectBindings), true);
    assert.equal(yield* check([]), false);
  }),
);

it.effect("blocks an Axis-bound session without a digest but preserves legacy sessions", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project-without-digest");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const binding = {
      threadId: ThreadId.make("thread-without-digest"),
      provider: "codex",
      providerInstanceId,
      runtimePayload: {},
    } as never;
    const catalog = {
      revision: 3,
      catalog: {
        contexts: [],
        projectBindings: [
          { contextId: "company", project: { environmentId: "env", projectId } },
        ],
        providerOwnerships: [],
        providerAccessGrants: [],
        capabilities: [],
        workHubSources: [],
      },
      updatedAt: "2026-09-10T00:00:00.000Z",
    };
    const check = (candidateProjectId: ProjectId | null, projectBindings = catalog.catalog.projectBindings) =>
      ServerRuntimeStartup.revalidateAxisContinuationContext({
        projectId: candidateProjectId,
        session: { providerInstanceId, model: "gpt-5" },
        binding,
      }).pipe(
        Effect.provideService(AxisContextCatalogStore.AxisContextCatalogStore, {
          get: Effect.succeed({ ...catalog, catalog: { ...catalog.catalog, projectBindings } }),
        } as never),
        Effect.provideService(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed("env"),
        } as never),
        Effect.provideService(AxisEffectiveContext.AxisEffectiveContext, {
          resolve: () => Effect.succeed({ digest: "unused" } as never),
        } as never),
        Effect.provideService(ProviderService.ProviderService, {
          getInstanceInfo: () => Effect.succeed({ driverKind: "codex" } as never),
        } as never),
      );

    assert.equal(yield* check(projectId), false);
    assert.equal(yield* check(projectId, []), true);
    assert.equal(yield* check(null), true);
    assert.equal(yield* check(AXIS_CHATS_PROJECT_ID), true);
  }),
);

it.effect("rechecks the Axis binding after preparation before sending a continuation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-revoked-during-recovery");
      const threadId = ThreadId.make("thread-revoked-during-recovery");
      const turnId = TurnId.make("turn-revoked-during-recovery");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const settled = yield* Deferred.make<void>();
      const sends: unknown[] = [];
      const dispatched: Array<{ readonly status: string; readonly lastError: string | null }> = [];
      const catalog = {
        revision: 4,
        catalog: {
          contexts: [],
          projectBindings: [
            { contextId: "company", project: { environmentId: "env", projectId } },
          ],
          providerOwnerships: [],
          providerAccessGrants: [],
          capabilities: [],
          workHubSources: [],
        },
        updatedAt: "2026-09-10T00:00:00.000Z",
      };
      let projectBindings: ReadonlyArray<unknown> = catalog.catalog.projectBindings;
      let binding: ProviderSessionDirectory.ProviderRuntimeBinding = {
        threadId,
        provider: "codex" as never,
        providerInstanceId,
        status: "running",
        resumeCursor: { threadId },
        runtimePayload: {
          axisContextDigest: "digest-current",
          activeTurnId: turnId,
          continueAfterServerUpdate: turnId,
        },
      };
      const thread = {
        id: threadId,
        projectId,
        archivedAt: null,
        deletedAt: null,
        interactionMode: "default",
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: turnId,
          model: "gpt-5",
          lastError: null,
          updatedAt: "2026-09-10T00:00:00.000Z",
        },
      };
      const providerService = {
        listSessions: () => Effect.succeed([]),
        getCapabilities: () =>
          Effect.succeed({ sessionModelSwitch: "in-session", promptlessTurnContinuation: true }),
        getInstanceInfo: () =>
          Effect.succeed({
            instanceId: providerInstanceId,
            driverKind: "codex",
            displayName: undefined,
            enabled: true,
            continuationIdentity: "native",
          }),
        sendTurn: (input: unknown) =>
          Effect.sync(() => {
            sends.push(input);
            return { threadId, turnId: TurnId.make("unexpected-send") };
          }),
      } as never;
      const directory = {
        getBinding: () => Effect.succeed(Option.some(binding)),
        upsert: (next: ProviderSessionDirectory.ProviderRuntimeBinding) =>
          Effect.sync(() => {
            binding = next;
          }),
        listBindings: () => Effect.succeed([]),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
      } as never;
      const dispatch = (command: unknown) =>
        Effect.gen(function* () {
          const session = (command as {
            readonly session: { readonly status: string; readonly lastError: string | null };
          }).session;
          dispatched.push({ status: session.status, lastError: session.lastError });
          const status = session.status;
          if (status === "starting") {
            projectBindings = [];
          }
          if (status === "error") {
            yield* Deferred.succeed(settled, undefined);
          }
          return { sequence: 1 };
        }) as never;

      yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getUserInputActivity: () => Effect.die("unused"),
          getCommandReadModel: () => Effect.succeed({ threads: [thread] } as never),
        } as never),
        Effect.provideService(ProviderService.ProviderService, providerService),
        Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, directory),
        Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () => Effect.die("unused"),
          dispatch,
          streamDomainEvents: Stream.empty,
          subscribeDomainEvents: Effect.succeed(Stream.empty),
          latestSequence: Effect.succeed(0),
        } as never),
        Effect.provideService(AxisContextCatalogStore.AxisContextCatalogStore, {
          get: Effect.sync(() => ({ ...catalog, catalog: { ...catalog.catalog, projectBindings } })),
        } as never),
        Effect.provideService(AxisEffectiveContext.AxisEffectiveContext, {
          resolve: () => Effect.succeed({ digest: "digest-current" } as never),
        } as never),
        Effect.provideService(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed("env"),
        } as never),
        Effect.provide(Layer.mergeAll(NodeServices.layer, ServerSettings.layerTest())),
      );
      yield* Deferred.await(settled);

      assert.deepStrictEqual(sends, []);
      assert.deepStrictEqual(dispatched, [
        { status: "starting", lastError: null },
        {
          status: "error",
          lastError:
            "Could not continue this thread because its Axis project context changed or was revoked. Send a new message to continue.",
        },
      ]);
      assert.equal(
        (binding.runtimePayload as { readonly continueAfterServerUpdate: null })
          .continueAfterServerUpdate,
        null,
      );
    }),
  ),
);

it.effect("does not restore a stale startup snapshot when preparation CAS loses", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-startup-preparation-cas-lost");
    const turnId = TurnId.make("turn-startup-preparation-cas-lost");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const stale: ProviderSessionDirectory.ProviderRuntimeBinding = {
      threadId,
      provider: "codex" as never,
      providerInstanceId,
      lastSeenAt: "2026-09-10T12:00:00.000Z",
      status: "running" as const,
      resumeCursor: { providerThread: "stale" },
      runtimePayload: {
        activeTurnId: turnId,
        continueAfterServerUpdate: turnId,
        axisContinuationEffect: {
          key: `server-update:${threadId}:${turnId}`,
          status: "prepared",
          providerInstanceId,
          driverKind: "codex",
        },
      },
    };
    const external: ProviderSessionDirectory.ProviderRuntimeBinding = {
      ...stale,
      status: "stopped",
      runtimePayload: { activeTurnId: "external-turn" },
    };
    let binding = stale;
    let compareAndSetCalls = 0;
    const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
    const sends: unknown[] = [];
    const dispatched: Array<{ readonly status: string; readonly lastError: string | null }> = [];

    yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getUserInputActivity: () => Effect.die("unused"),
        getCommandReadModel: () =>
          Effect.succeed({
            threads: [
              {
                id: threadId,
                projectId: null,
                archivedAt: null,
                deletedAt: null,
                interactionMode: "default",
                session: {
                  threadId,
                  status: "running",
                  providerName: "codex",
                  providerInstanceId,
                  runtimeMode: "full-access",
                  activeTurnId: turnId,
                  lastError: null,
                  updatedAt: "2026-09-10T12:00:00.000Z",
                },
              },
            ],
          } as never),
      } as never),
      Effect.provideService(ProviderService.ProviderService, {
        listSessions: () => Effect.succeed([]),
        getCapabilities: () =>
          Effect.succeed({ sessionModelSwitch: "in-session", promptlessTurnContinuation: true }),
        getInstanceInfo: () => Effect.succeed({ driverKind: "codex" } as never),
        sendTurn: (input: unknown) =>
          Effect.sync(() => {
            sends.push(input);
            return { threadId, turnId: TurnId.make("unexpected") };
          }),
        settleContinuation: () => Effect.succeed(false),
      } as never),
      Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, {
        getBinding: () => Effect.succeed(Option.some(binding)),
        upsert: (next: ProviderSessionDirectory.ProviderRuntimeBinding) =>
          Effect.sync(() => upserts.push(next)),
        compareAndSet: () =>
          Effect.sync(() => {
            compareAndSetCalls += 1;
            binding = external;
            return false;
          }),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.succeed([]),
      } as never),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        dispatch: (command: unknown) =>
          Effect.sync(() => {
            const session = (command as {
              readonly session: { readonly status: string; readonly lastError: string | null };
            }).session;
            dispatched.push({ status: session.status, lastError: session.lastError });
            return { sequence: 1 };
          }),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      } as never),
      Effect.provide( Layer.mergeAll(NodeServices.layer, ServerSettings.layerTest())),
    );

    assert.equal(compareAndSetCalls, 1);
    assert.deepEqual(upserts, []);
    assert.deepEqual(sends, []);
    assert.deepEqual(binding, external);
    assert.deepEqual(dispatched.map(({ status, lastError }) => ({ status, lastError })), [
      {
        status: "error",
        lastError:
          "Could not continue this thread because its Axis project context changed or was revoked. Send a new message to continue.",
      },
    ]);
  }),
);

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.succeed({
          isRepo: true,
          isDefaultBranch: cwd !== "/feature",
          hasUpstream: true,
          hasWorkingTreeChanges: cwd === "/dirty",
          aheadCount: cwd === "/ahead" ? 1 : 0,
          behindCount: cwd === "/current" ? 0 : 1,
        } as never),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string, autoPull = true) =>
      ({ workspaceRoot, autoPull }) as never;

    yield* ServerRuntimeStartup.autoPullProjects([
      project("/clean"),
      project("/current"),
      project("/dirty"),
      project("/ahead"),
      project("/feature"),
      project("/disabled", false),
    ]).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);
  }),
);

it.effect("enqueueCommand waits for readiness and then drains queued work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executionCount = yield* Ref.make(0);
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Ref.updateAndGet(executionCount, (count) => count + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(executionCount), 0);

      yield* commandGate.signalCommandReady;

      const result = yield* Fiber.join(queuedCommandFiber);
      assert.equal(result, 1);
      assert.equal(yield* Ref.get(executionCount), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("launchStartupHeartbeat does not block the caller while counts are loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseCounts = yield* Deferred.make<void, never>();
      const countsStarted = yield* Deferred.make<void, never>();

      yield* ServerRuntimeStartup.launchStartupHeartbeat.pipe(
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getUserInputActivity: () => Effect.die("unused"),
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
          getEventReplayStats: () => Effect.die("unused"),
          getCounts: () =>
            Deferred.succeed(countsStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseCounts)),
              Effect.as({
                projectCount: 2,
                threadCount: 3,
              }),
            ),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getFullThreadDiffContext: () => Effect.succeed(Option.none()),
          getThreadRuntimeContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
          searchThreads: () => Effect.succeed({ matches: [] }),
        }),
        Effect.provideService(AnalyticsService.AnalyticsService, {
          record: () => Effect.void,
          flush: Effect.void,
        }),
      );

      // The heartbeat is forked, so the caller is already back here while
      // getCounts is still parked. Awaiting countsStarted proves the forked
      // work really ran; releaseCounts staying incomplete proves the caller
      // never waited for it.
      yield* Deferred.await(countsStarted);
      assert.equal(yield* Deferred.isDone(releaseCounts), false);
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("resolveAutoBootstrapWelcomeTargets returns existing project and thread ids", () => {
  const bootstrapProjectId = ProjectId.make("project-startup-bootstrap");
  const bootstrapThreadId = ThreadId.make("thread-startup-bootstrap");

  return Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getUserInputActivity: () => Effect.die("unused"),
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getEventReplayStats: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () =>
          Effect.succeed(
            Option.some({
              id: bootstrapProjectId,
              title: "Startup Project",
              workspaceRoot: "/tmp/startup-project",
              defaultModelSelection: ServerRuntimeStartup.getAutoBootstrapThreadModelSelection(),
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
            }),
          ),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.some(bootstrapThreadId)),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadRuntimeContext: () => Effect.die("unused"),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused thread replay stats"),
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    assert.deepStrictEqual(targets, {
      bootstrapProjectId,
      bootstrapThreadId,
    });
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  });
});

it.effect("resolveAutoBootstrapWelcomeTargets creates a project and thread when missing", () =>
  Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<
      ReadonlyArray<{
        readonly type: string;
        readonly defaultModelSelection?: unknown;
        readonly modelSelection?: unknown;
      }>
    >([]);
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getUserInputActivity: () => Effect.die("unused"),
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getEventReplayStats: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadRuntimeContext: () => Effect.die("unused"),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused thread replay stats"),
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    assert.equal(typeof targets.bootstrapProjectId, "string");
    assert.equal(typeof targets.bootstrapThreadId, "string");
    const commands = yield* Ref.get(dispatchCalls);
    assert.deepStrictEqual(
      commands.map((command) => command.type),
      ["project.create", "thread.create"],
    );
    assert.equal("defaultModelSelection" in commands[0]!, false);
    assert.deepStrictEqual(
      commands[1]?.modelSelection,
      ServerRuntimeStartup.getAutoBootstrapThreadModelSelection(),
    );
  }),
);

it.effect("resolveAutoBootstrapWelcomeTargets preserves typed UUID generation failures", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const uuidError = PlatformError.systemError({
      _tag: "Unknown",
      module: "Crypto",
      method: "randomUUIDv4",
      description: "UUID generation unavailable",
    });
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);

    const error = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getUserInputActivity: () => Effect.die("unused"),
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getEventReplayStats: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadRuntimeContext: () => Effect.die("unused"),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused thread replay stats"),
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provideService(Crypto.Crypto, {
        ...crypto,
        randomUUIDv4: Effect.fail(uuidError),
      }),
      Effect.flip,
    );

    assert.strictEqual(error, uuidError);
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

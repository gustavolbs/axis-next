import {
  AxisProjectProfileConflictError,
  AxisLearningConflictError,
  AxisOnboardingRunId,
  CommandId,
  type AxisLearningSnapshot,
  type AxisLearningListInput,
  type AxisLearningDeactivateInput,
  EnvironmentId,
  WS_METHODS,
  type AxisContextProjectScope,
  type AxisProjectProfile,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const environmentId = EnvironmentId.make("axis-project-work");
const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Axis project work",
  httpBaseUrl: "https://axis.example.test",
  wsBaseUrl: "wss://axis.example.test",
});

const scope = (projectId: string): AxisContextProjectScope => ({
  contextId: "company" as AxisContextProjectScope["contextId"],
  project: {
    environmentId,
    projectId: projectId as AxisContextProjectScope["project"]["projectId"],
  },
});

const profile = (projectId: string, revision: number): AxisProjectProfile => ({
  scope: scope(projectId),
  revision,
  sources: [],
  facts: [],
  rules: [],
  manualDecisions: [],
  workflow: [],
  tokenEfficiencyPolicies: [],
  updatedAt: "2026-09-09T00:00:00.000Z",
});

function makeCache(): EnvironmentCacheStore["Service"] {
  return {
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeed(Option.none()),
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  };
}

describe("Axis project work client state", () => {
  it.effect("isolates project keys, refreshes only the written scope, and exposes conflicts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let projectA = profile("project-a", 0);
        const projectB = profile("project-b", 0);
        let readCount = 0;
        let learningA: AxisLearningSnapshot = {
          contextId: scope("project-a").contextId,
          evidence: [],
          proposals: [],
          versions: [],
          activeVersions: [],
          activeStates: [],
          lifecycle: [],
        };
        const learningB = { ...learningA };
        let learningBReads = 0;
        const client = {
          [WS_METHODS.axisLearningGetSnapshot]: (input: typeof AxisLearningListInput.Type) =>
            Effect.sync(() => {
              if (input.scope?.project?.projectId === "project-a") return learningA;
              learningBReads += 1;
              return learningB;
            }),
          [WS_METHODS.axisLearningDeactivateVersion]: (input: AxisLearningDeactivateInput) => {
            if (input.expectedRevision !== (learningA.activeStates[0]?.revision ?? 0)) {
              return Effect.fail(
                new AxisLearningConflictError({ entity: "activation", id: input.targetKey }),
              );
            }
            const activeState = {
              scope: input.scope,
              targetKey: input.targetKey,
              versionId: null,
              revision: input.expectedRevision + 1,
              updatedAt: "2026-09-09T00:00:00.000Z",
            };
            learningA = { ...learningA, activeStates: [activeState] };
            return Effect.succeed({ activeState, lifecycleEvent: null });
          },
          [WS_METHODS.axisProjectProfileGet]: (input: {
            readonly scope: AxisContextProjectScope;
          }) =>
            Effect.sync(() => {
              readCount += 1;
              return input.scope.project.projectId === "project-a" ? projectA : projectB;
            }),
          [WS_METHODS.axisProjectProfileReplace]: (input: {
            readonly scope: AxisContextProjectScope;
            readonly expectedRevision: number;
          }) => {
            if (input.expectedRevision !== projectA.revision) {
              return Effect.fail(
                new AxisProjectProfileConflictError({
                  scope: input.scope,
                  expectedRevision: input.expectedRevision,
                  actualRevision: projectA.revision,
                }),
              );
            }
            projectA = profile("project-a", projectA.revision + 1);
            return Effect.succeed(projectA);
          },
          [WS_METHODS.axisOnboardingApply]: () => {
            projectA = profile("project-a", projectA.revision + 1);
            return Effect.succeed({
              profile: projectA,
              invalidatedRuleIds: [],
              acceptedCandidateIds: [],
              run: {
                run: {
                  id: "onboarding-a",
                  scope: scope("project-a"),
                  execution: { threadId: "thread-a", turnId: "turn-a", commandId: "scan-a" },
                  status: "completed",
                  sources: [],
                  digests: [],
                  facts: [],
                  candidateRules: [],
                  conflicts: [],
                  decisions: [],
                  error: null,
                  startedAt: "2026-09-10T00:00:00.000Z",
                  finishedAt: "2026-09-10T00:01:00.000Z",
                },
                progress: { stage: "completed", completedSteps: 3, totalSteps: 3, message: null },
              },
            });
          },
        } as unknown as WsRpcProtocolClient;
        const session: RpcSession = {
          client,
          initialConfig: Effect.succeed(null as never),
          subscribeServerConfig: () => Stream.empty,
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        };
        const supervisor = EnvironmentSupervisor.of({
          target,
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected",
          }),
          session: yield* SubscriptionRef.make(Option.some(session)),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const environments = EnvironmentRegistry.of({
          run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(
          Layer.merge(
            Layer.succeed(EnvironmentRegistry, environments),
            Layer.succeed(EnvironmentCacheStore, makeCache()),
          ),
        );
        const atoms = createServerEnvironmentAtoms(runtime, {
          initialConfigValueAtom: () => Atom.make(null),
        });
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
          Effect.sync(() => value.dispose()),
        );
        const projectAAtom = atoms.axisProjectProfile({
          environmentId,
          input: { scope: scope("project-a") },
        });
        const projectBAtom = atoms.axisProjectProfile({
          environmentId,
          input: { scope: scope("project-b") },
        });
        expect(projectAAtom).not.toBe(projectBAtom);
        yield* Effect.promise(() =>
          Promise.all([
            AtomRegistry.getResult(registry, projectAAtom, { suspendOnWaiting: true }),
            AtomRegistry.getResult(registry, projectBAtom, { suspendOnWaiting: true }),
          ]),
        );

        const refreshedA = yield* Stream.runHead(
          AtomRegistry.toStream(registry, projectAAtom).pipe(
            Stream.filter((result) => AsyncResult.isSuccess(result) && result.value.revision === 1),
          ),
        ).pipe(Effect.forkChild);
        const update = yield* Effect.promise(() =>
          atoms.replaceAxisProjectProfile.run(registry, {
            environmentId,
            input: { scope: scope("project-a"), expectedRevision: 0, changes: [] },
          }),
        );
        expect(AsyncResult.isSuccess(update)).toBe(true);
        yield* Fiber.join(refreshedA);
        const unchangedB = yield* AtomRegistry.getResult(registry, projectBAtom, {
          suspendOnWaiting: true,
        });
        expect(unchangedB.revision).toBe(0);

        const conflict = yield* Effect.promise(() =>
          atoms.replaceAxisProjectProfile.run(registry, {
            environmentId,
            input: { scope: scope("project-a"), expectedRevision: 0, changes: [] },
          }),
        );
        expect(AsyncResult.isFailure(conflict)).toBe(true);

        const appliedProfile = yield* Stream.runHead(
          AtomRegistry.toStream(registry, projectAAtom).pipe(
            Stream.filter((result) => AsyncResult.isSuccess(result) && result.value.revision === 2),
          ),
        ).pipe(Effect.forkChild);
        const applied = yield* Effect.promise(() =>
          atoms.applyAxisOnboarding.run(registry, {
            environmentId,
            input: {
              scope: scope("project-a"),
              runId: AxisOnboardingRunId.make("onboarding-a"),
              expectedProfileRevision: 1,
              decisions: [],
              commandId: CommandId.make("apply-a"),
            },
          }),
        );
        expect(AsyncResult.isSuccess(applied)).toBe(true);
        yield* Fiber.join(appliedProfile);
        expect((yield* AtomRegistry.getResult(registry, projectBAtom)).revision).toBe(0);

        const learningAAtom = atoms.axisLearningSnapshot({
          environmentId,
          input: { contextId: scope("project-a").contextId, scope: scope("project-a") },
        });
        const learningBAtom = atoms.axisLearningSnapshot({
          environmentId,
          input: { contextId: scope("project-b").contextId, scope: scope("project-b") },
        });
        yield* Effect.promise(() =>
          Promise.all([
            AtomRegistry.getResult(registry, learningAAtom, { suspendOnWaiting: true }),
            AtomRegistry.getResult(registry, learningBAtom, { suspendOnWaiting: true }),
          ]),
        );
        const readsBeforeMutation = learningBReads;
        const refreshedLearning = yield* Stream.runHead(
          AtomRegistry.toStream(registry, learningAAtom).pipe(
            Stream.filter(
              (result) =>
                AsyncResult.isSuccess(result) && result.value.activeStates[0]?.revision === 1,
            ),
          ),
        ).pipe(Effect.forkChild);
        const mutation = {
          environmentId,
          input: {
            scope: scope("project-a"),
            targetKey: "provider:codex:step:execute",
            expectedRevision: 0,
            commandId: CommandId.make("deactivate-a"),
          },
        };
        const deactivated = yield* Effect.promise(() =>
          atoms.deactivateAxisLearningVersion.run(registry, mutation),
        );
        expect(AsyncResult.isSuccess(deactivated)).toBe(true);
        yield* Fiber.join(refreshedLearning);
        expect(learningBReads).toBe(readsBeforeMutation);
        const rejected = yield* Effect.promise(() =>
          atoms.deactivateAxisLearningVersion.run(registry, {
            ...mutation,
            input: { ...mutation.input, commandId: CommandId.make("stale-deactivate-a") },
          }),
        );
        expect(AsyncResult.isFailure(rejected)).toBe(true);

        yield* SubscriptionRef.set(supervisor.state, {
          ...AVAILABLE_CONNECTION_STATE,
          phase: "offline" as const,
        });
        yield* SubscriptionRef.set(supervisor.session, Option.none());
        const readsBeforeOffline = readCount;
        const foreignEnvironment = EnvironmentId.make("another-environment");
        for (const otherScope of [
          scope("project-c"),
          {
            ...scope("project-a"),
            contextId: "another-context" as AxisContextProjectScope["contextId"],
          },
          {
            ...scope("project-a"),
            project: { ...scope("project-a").project, environmentId: foreignEnvironment },
          },
        ]) {
          const offlineAtom = atoms.axisProjectProfile({
            environmentId: otherScope.project.environmentId,
            input: { scope: otherScope },
          });
          const result = yield* AtomRegistry.getResult(registry, offlineAtom, {
            suspendOnWaiting: true,
          }).pipe(Effect.exit);
          expect(Exit.isFailure(result)).toBe(true);
          expect(Option.isNone(AsyncResult.value(registry.get(offlineAtom)))).toBe(true);
        }
        expect(readCount).toBe(readsBeforeOffline);
      }),
    ),
  );
});

import {
  AxisTaskConflictError,
  AxisTaskId,
  AxisTaskStepId,
  CommandId,
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  type AxisContextProjectScope,
  type AxisTaskExtension,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
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

const environmentId = EnvironmentId.make("axis-task-work");
const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Axis task work",
  httpBaseUrl: "https://axis.example.test",
  wsBaseUrl: "wss://axis.example.test",
});

const scope = (projectId: string): AxisContextProjectScope => ({
  contextId: "company" as AxisContextProjectScope["contextId"],
  project: { environmentId, projectId: projectId as AxisContextProjectScope["project"]["projectId"] },
});

const task = (projectId: string, revision: number): AxisTaskExtension => ({
  id: AxisTaskId.make(`task-${projectId}`),
  scope: scope(projectId),
  threadId: ThreadId.make(`thread-${projectId}`),
  source: { kind: "local", label: `Task ${projectId}` },
  title: `Task ${projectId}`,
  acceptanceCriteria: [{ id: AxisTaskStepId.make(`criteria-${projectId}`), text: "It works." }],
  workflowVersion: "axis-default-1",
  steps: [],
  status: "active",
  revision,
  createdAt: "2026-09-09T00:00:00.000Z",
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

afterEach(() => vi.restoreAllMocks());

describe("Axis task client state", () => {
  it.effect("isolates task scopes, refreshes only the written scope, and exposes conflicts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tasks: Record<string, AxisTaskExtension> = {
          "project-a": task("project-a", 0),
          "project-b": task("project-b", 0),
        };
        const listCalls = new Map<string, number>();
        const detailCalls = new Map<string, number>();
        const increment = (calls: Map<string, number>, projectId: string) =>
          calls.set(projectId, (calls.get(projectId) ?? 0) + 1);
        const client = {
          [WS_METHODS.axisTasksList]: (input: { readonly scope: AxisContextProjectScope }) => {
            const projectId = input.scope.project.projectId;
            increment(listCalls, projectId);
            return Effect.succeed([tasks[projectId]!]);
          },
          [WS_METHODS.axisTasksGet]: (input: {
            readonly scope: AxisContextProjectScope;
            readonly threadId: ThreadId;
          }) => {
            const projectId = input.scope.project.projectId;
            increment(detailCalls, projectId);
            return Effect.succeed(tasks[projectId] ?? null);
          },
          [WS_METHODS.axisTasksUpdate]: (input: {
            readonly task: AxisTaskExtension;
            readonly expectedRevision: number;
          }) => {
            const projectId = input.task.scope.project.projectId;
            const current = tasks[projectId]!;
            if (input.expectedRevision !== current.revision) {
              return Effect.fail(new AxisTaskConflictError({ taskId: input.task.id }));
            }
            tasks[projectId] = {
              ...input.task,
              revision: current.revision + 1,
              updatedAt: "2026-09-09T00:01:00.000Z",
            };
            return Effect.succeed(tasks[projectId]);
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
        const scopeA = scope("project-a");
        const scopeB = scope("project-b");
        const tasksA = atoms.axisTasks({ environmentId, input: { scope: scopeA } });
        const tasksB = atoms.axisTasks({ environmentId, input: { scope: scopeB } });
        const taskA = atoms.axisTask({
          environmentId,
          input: { scope: scopeA, threadId: tasks["project-a"]!.threadId },
        });
        const taskB = atoms.axisTask({
          environmentId,
          input: { scope: scopeB, threadId: tasks["project-b"]!.threadId },
        });

        expect(tasksA).not.toBe(tasksB);
        expect(taskA).not.toBe(taskB);
        yield* AtomRegistry.mount(registry, tasksA);
        yield* AtomRegistry.mount(registry, tasksB);
        yield* AtomRegistry.mount(registry, taskA);
        yield* AtomRegistry.mount(registry, taskB);
        yield* Effect.promise(() =>
          Promise.all([
            AtomRegistry.getResult(registry, tasksA, { suspendOnWaiting: true }),
            AtomRegistry.getResult(registry, tasksB, { suspendOnWaiting: true }),
            AtomRegistry.getResult(registry, taskA, { suspendOnWaiting: true }),
            AtomRegistry.getResult(registry, taskB, { suspendOnWaiting: true }),
          ]),
        );
        expect(listCalls.get("project-a")).toBe(1);
        expect(listCalls.get("project-b")).toBe(1);
        expect(detailCalls.get("project-a")).toBe(1);
        expect(detailCalls.get("project-b")).toBe(1);

        const refreshedListA = yield* Stream.runHead(
          AtomRegistry.toStream(registry, tasksA).pipe(
            Stream.filter(
              (result) => AsyncResult.isSuccess(result) && result.value[0]?.revision === 1,
            ),
          ),
        ).pipe(Effect.forkChild);
        const refreshedTaskA = yield* Stream.runHead(
          AtomRegistry.toStream(registry, taskA).pipe(
            Stream.filter(
              (result) =>
                AsyncResult.isSuccess(result) &&
                result.value !== null &&
                result.value.revision === 1,
            ),
          ),
        ).pipe(Effect.forkChild);
        const update = yield* Effect.promise(() =>
          atoms.updateAxisTask.run(registry, {
            environmentId,
            input: {
              task: tasks["project-a"]!,
              expectedRevision: 0,
              commandId: CommandId.make("update-project-a"),
            },
          }),
        );
        expect(AsyncResult.isSuccess(update)).toBe(true);
        yield* Fiber.join(refreshedListA);
        yield* Fiber.join(refreshedTaskA);

        const unchangedListB = yield* AtomRegistry.getResult(registry, tasksB, {
          suspendOnWaiting: true,
        });
        const unchangedTaskB = yield* AtomRegistry.getResult(registry, taskB, {
          suspendOnWaiting: true,
        });
        expect(unchangedListB[0]?.revision).toBe(0);
        expect(unchangedTaskB?.revision).toBe(0);
        expect(listCalls.get("project-a")).toBe(2);
        expect(listCalls.get("project-b")).toBe(1);
        expect(detailCalls.get("project-a")).toBe(2);
        expect(detailCalls.get("project-b")).toBe(1);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const conflict = yield* Effect.promise(() =>
          atoms.updateAxisTask.run(registry, {
            environmentId,
            input: {
              task: tasks["project-a"]!,
              expectedRevision: 0,
              commandId: CommandId.make("stale-update-project-a"),
            },
          }),
        );
        expect(AsyncResult.isFailure(conflict)).toBe(true);
        if (AsyncResult.isFailure(conflict)) {
          expect(Cause.squash(conflict.cause)).toBeInstanceOf(AxisTaskConflictError);
        }
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        expect(listCalls.get("project-a")).toBe(2);
        expect(detailCalls.get("project-a")).toBe(2);
      }),
    ),
  );
});

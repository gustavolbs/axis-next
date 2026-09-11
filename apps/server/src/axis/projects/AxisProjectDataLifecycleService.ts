/**
 * X13 — AxisProjectDataLifecycle runtime.
 *
 * Adapts the policy module to the live stores so an authorized RPC can
 * purge, export or delete the mutable rows that belong to a single
 * project. The policy itself rejects cross-context promotion and
 * scope_mismatch; this module merely feeds it real data.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  AxisContextProjectScope,
  AxisLearningSnapshot,
  AxisProjectProfile,
  AxisTaskExtension,
} from "@t3tools/contracts";

import type {
  AxisProjectDataLifecycleAuthorization,
  AxisProjectDataLifecycleAuthorizationRequest,
  AxisProjectDataLifecycleDeletePlan,
  AxisProjectDataLifecycleExport,
  AxisProjectDataLifecyclePurgePlan,
} from "./AxisProjectDataLifecycle.ts";
import {
  authorizeAxisProjectDataLifecycleAction,
  planAxisProjectDataDelete,
  planAxisProjectDataExport,
  planAxisProjectDataPurge,
} from "./AxisProjectDataLifecycle.ts";
import { AxisLearningStore } from "../learning/AxisLearningStore.ts";
import { AxisProjectProfileStore } from "./AxisProjectProfileStore.ts";
import { AxisTaskStore } from "../tasks/AxisTaskStore.ts";

export class AxisProjectDataLifecycleServiceError extends Error {
  readonly _tag = "AxisProjectDataLifecycleServiceError" as const;
  readonly action: AxisProjectDataLifecycleAuthorizationRequest["action"];
  readonly scope: AxisContextProjectScope;
  constructor(
    action: AxisProjectDataLifecycleAuthorizationRequest["action"],
    scope: AxisContextProjectScope,
    message: string,
  ) {
    super(message);
    this.action = action;
    this.scope = scope;
  }
}

export interface AxisProjectDataLifecycleService {
  readonly authorize: (
    request: AxisProjectDataLifecycleAuthorizationRequest,
  ) => Effect.Effect<AxisProjectDataLifecycleAuthorization, AxisProjectDataLifecycleServiceError>;
  readonly export: (
    authorization: AxisProjectDataLifecycleAuthorization,
    now?: string,
  ) => Effect.Effect<AxisProjectDataLifecycleExport, AxisProjectDataLifecycleServiceError>;
  readonly purge: (
    authorization: AxisProjectDataLifecycleAuthorization,
    now?: string,
  ) => Effect.Effect<AxisProjectDataLifecyclePurgePlan, AxisProjectDataLifecycleServiceError>;
  readonly delete: (
    authorization: AxisProjectDataLifecycleAuthorization,
  ) => Effect.Effect<AxisProjectDataLifecycleDeletePlan, AxisProjectDataLifecycleServiceError>;
}

const wrap = <A, E>(
  effect: Effect.Effect<A, E>,
  action: AxisProjectDataLifecycleAuthorizationRequest["action"],
  scope: AxisContextProjectScope,
): Effect.Effect<A, AxisProjectDataLifecycleServiceError> =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new AxisProjectDataLifecycleServiceError(
          action,
          scope,
          cause instanceof Error ? cause.message : String(cause),
        ),
    ),
  );

type LifecycleDataset = {
  readonly profile: AxisProjectProfile | null;
  readonly learning: AxisLearningSnapshot;
  readonly tasks?: ReadonlyArray<AxisTaskExtension>;
};

export const make = Effect.gen(function* () {
  const learning = yield* AxisLearningStore;
  const profile = yield* AxisProjectProfileStore;
  const tasks = yield* AxisTaskStore;

  const loadProfile = (
    scope: AxisContextProjectScope,
  ): Effect.Effect<AxisProjectProfile | null, never> =>
    profile.get(scope).pipe(
      Effect.map((row) => row as AxisProjectProfile | null),
      Effect.orElseSucceed(() => null),
    );

  const loadLearning = (scope: AxisContextProjectScope) => learning.getSnapshot(scope.contextId);

  const loadTasks = (scope: AxisContextProjectScope) =>
    tasks.list(scope).pipe(Effect.map((rows) => rows as ReadonlyArray<AxisTaskExtension>));

  return {
    authorize: (request) =>
      wrap(authorizeAxisProjectDataLifecycleAction(request), request.action, request.scope),
    export: (authorization, now) => {
      const timestamp = now ?? DateTime.formatIso(DateTime.nowUnsafe());
      return Effect.gen(function* () {
        const profileValue = yield* loadProfile(authorization.scope);
        const snapshot = yield* wrap(
          loadLearning(authorization.scope),
          "export",
          authorization.scope,
        );
        const taskList = yield* wrap(loadTasks(authorization.scope), "export", authorization.scope);
        const dataset: LifecycleDataset = {
          profile: profileValue,
          learning: snapshot,
          tasks: taskList,
        };
        return yield* wrap(
          planAxisProjectDataExport(authorization, dataset, timestamp),
          "export",
          authorization.scope,
        );
      });
    },
    purge: (authorization, now) => {
      const timestamp = now ?? DateTime.formatIso(DateTime.nowUnsafe());
      return Effect.gen(function* () {
        const snapshot = yield* wrap(
          loadLearning(authorization.scope),
          "purge",
          authorization.scope,
        );
        return yield* wrap(
          planAxisProjectDataPurge(authorization, { learning: snapshot }, timestamp),
          "purge",
          authorization.scope,
        );
      });
    },
    delete: (authorization) =>
      Effect.gen(function* () {
        const profileValue = yield* loadProfile(authorization.scope);
        const snapshot = yield* wrap(
          loadLearning(authorization.scope),
          "delete",
          authorization.scope,
        );
        const taskList = yield* wrap(loadTasks(authorization.scope), "delete", authorization.scope);
        const dataset: LifecycleDataset = {
          profile: profileValue,
          learning: snapshot,
          tasks: taskList,
        };
        return yield* wrap(
          planAxisProjectDataDelete(authorization, dataset),
          "delete",
          authorization.scope,
        );
      }),
  } satisfies AxisProjectDataLifecycleService;
});

export class AxisProjectDataLifecycleServiceTag extends Context.Service<
  AxisProjectDataLifecycleServiceTag,
  Effect.Success<typeof make>
>()("t3/axis/projects/AxisProjectDataLifecycleService") {}
export const layer = Layer.effect(AxisProjectDataLifecycleServiceTag, make);

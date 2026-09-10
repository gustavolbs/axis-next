import {
  AxisContextId,
  AxisProviderInstanceLocator,
  EnvironmentId,
  ProjectId,
  axisProjectLocatorKey,
  axisProviderInstanceLocatorKey,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { AxisContextCatalogStore } from "../contexts/AxisContextCatalogStore.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";

export const AxisProjectScopeOperation = Schema.Literals(["read", "write", "execute"]);
export type AxisProjectScopeOperation = typeof AxisProjectScopeOperation.Type;

export const AxisProjectScopeCaller = Schema.Struct({
  environmentId: EnvironmentId,
  contextId: AxisContextId,
});
export type AxisProjectScopeCaller = typeof AxisProjectScopeCaller.Type;

const AxisContextProjectScope = Schema.Struct({
  contextId: AxisContextId,
  project: Schema.Struct({
    environmentId: EnvironmentId,
    projectId: ProjectId,
  }),
});
type AxisContextProjectScope = typeof AxisContextProjectScope.Type;

export const AxisProjectScopeRequest = Schema.Struct({
  caller: AxisProjectScopeCaller,
  operation: AxisProjectScopeOperation,
  scope: AxisContextProjectScope,
  provider: AxisProviderInstanceLocator,
});
export type AxisProjectScopeRequest = typeof AxisProjectScopeRequest.Type;

export const AxisProjectRequest = Schema.Struct({
  caller: AxisProjectScopeCaller,
  operation: AxisProjectScopeOperation,
  scope: AxisContextProjectScope,
});
export type AxisProjectRequest = typeof AxisProjectRequest.Type;

export class AxisProjectScopeResolutionError extends Schema.TaggedErrorClass<AxisProjectScopeResolutionError>()(
  "AxisProjectScopeResolutionError",
  {
    reason: Schema.Literals([
      "caller_environment_mismatch",
      "caller_context_mismatch",
      "unknown_context",
      "project_environment_mismatch",
      "project_not_found",
      "project_not_bound",
      "provider_environment_mismatch",
      "provider_not_accessible",
      "provider_grant_invalid",
    ]),
    message: Schema.String,
  },
) {}

export const AxisResolvedProjectScope = Schema.Struct({
  caller: AxisProjectScopeCaller,
  operation: AxisProjectScopeOperation,
  scope: AxisContextProjectScope,
  provider: AxisProviderInstanceLocator,
});
export type AxisResolvedProjectScope = typeof AxisResolvedProjectScope.Type;

export class AxisProjectScope extends Context.Service<
  AxisProjectScope,
  {
    /** Resolves the current physical project/context/provider relationship. */
    readonly resolveProject: (
      request: AxisProjectRequest,
    ) => Effect.Effect<AxisProjectRequest, AxisProjectScopeResolutionError>;
    readonly resolve: (
      request: AxisProjectScopeRequest,
    ) => Effect.Effect<AxisResolvedProjectScope, AxisProjectScopeResolutionError>;
  }
>()("t3/axis/projects/AxisProjectScope") {}

const fail = (
  reason: AxisProjectScopeResolutionError["reason"],
  message: string,
): Effect.Effect<never, AxisProjectScopeResolutionError> =>
  Effect.fail(new AxisProjectScopeResolutionError({ reason, message }));

export const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment;
  const catalogStore = yield* AxisContextCatalogStore;
  const projections = yield* ProjectionSnapshotQuery;

  const resolveProject: AxisProjectScope["Service"]["resolveProject"] = (request) =>
    Effect.gen(function* () {
      const environmentId = yield* environment.getEnvironmentId;
      if (request.caller.environmentId !== environmentId) {
        return yield* fail(
          "caller_environment_mismatch",
          "The caller does not belong to this server environment.",
        );
      }
      if (request.scope.contextId !== request.caller.contextId) {
        return yield* fail(
          "caller_context_mismatch",
          "The caller cannot operate on another Axis context.",
        );
      }
      if (request.scope.project.environmentId !== environmentId) {
        return yield* fail(
          "project_environment_mismatch",
          "The Project belongs to another environment.",
        );
      }
      const catalog = yield* catalogStore.get.pipe(
        Effect.mapError(
          () =>
            new AxisProjectScopeResolutionError({
              reason: "provider_not_accessible",
              message: "The Axis context catalog could not be read.",
            }),
        ),
      );
      const context = catalog.catalog.contexts.find(
        (candidate) => candidate.id === request.scope.contextId,
      );
      if (!context) {
        return yield* fail("unknown_context", "The Axis context does not exist.");
      }

      const project = yield* projections.getProjectShellById(request.scope.project.projectId).pipe(
        Effect.mapError(
          () =>
            new AxisProjectScopeResolutionError({
              reason: "project_not_found",
              message: "The Project could not be read from this environment.",
            }),
        ),
      );
      if (project._tag === "None") {
        return yield* fail("project_not_found", "The Project does not exist in this environment.");
      }

      const projectKey = axisProjectLocatorKey(request.scope.project);
      const bound = catalog.catalog.projectBindings.some(
        (candidate) =>
          candidate.contextId === request.scope.contextId &&
          axisProjectLocatorKey(candidate.project) === projectKey,
      );
      if (!bound) {
        return yield* fail("project_not_bound", "The Project is not bound to this Axis context.");
      }

      return request;
    });

  const resolve: AxisProjectScope["Service"]["resolve"] = (request) =>
    Effect.gen(function* () {
      yield* resolveProject({
        caller: request.caller,
        operation: request.operation,
        scope: request.scope,
      });
      const environmentId = yield* environment.getEnvironmentId;
      if (request.provider.environmentId !== environmentId) {
        return yield* fail(
          "provider_environment_mismatch",
          "The provider belongs to another environment.",
        );
      }
      const catalog = yield* catalogStore.get.pipe(
        Effect.mapError(
          () =>
            new AxisProjectScopeResolutionError({
              reason: "provider_not_accessible",
              message: "The Axis context catalog could not be read.",
            }),
        ),
      );
      const context = catalog.catalog.contexts.find(
        (candidate) => candidate.id === request.scope.contextId,
      );
      if (!context) {
        return yield* fail("unknown_context", "The Axis context does not exist.");
      }
      const providerKey = axisProviderInstanceLocatorKey(request.provider);
      const owned = catalog.catalog.providerOwnerships.some(
        (candidate) =>
          candidate.contextId === context.id &&
          axisProviderInstanceLocatorKey(candidate.provider) === providerKey,
      );
      const grant = catalog.catalog.providerAccessGrants.find(
        (candidate) =>
          candidate.targetContextId === context.id &&
          candidate.status === "active" &&
          axisProviderInstanceLocatorKey(candidate.provider) === providerKey,
      );
      const granted =
        grant !== undefined &&
        catalog.catalog.contexts.some(
          (candidate) => candidate.id === grant.ownerContextId && candidate.kind === "personal",
        ) &&
        context.kind === "company" &&
        catalog.catalog.providerOwnerships.some(
          (candidate) =>
            candidate.contextId === grant.ownerContextId &&
            axisProviderInstanceLocatorKey(candidate.provider) === providerKey,
        );
      if (!owned && !granted) {
        return yield* fail(
          grant === undefined ? "provider_not_accessible" : "provider_grant_invalid",
          "The provider is not owned by or granted to this Axis context.",
        );
      }

      return {
        caller: request.caller,
        operation: request.operation,
        scope: request.scope,
        provider: request.provider,
      };
    });

  return { resolveProject, resolve } satisfies AxisProjectScope["Service"];
});

export const layer = Layer.effect(AxisProjectScope, make);

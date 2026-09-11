import { assert, it } from "@effect/vitest";
import { AxisContextCatalog, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { AxisContextCatalogStore } from "../contexts/AxisContextCatalogStore.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  AxisProjectScope,
  AxisProjectScopeRequest,
  AxisProjectScopeResolutionError,
  make,
} from "./AxisProjectScope.ts";

const catalog = Schema.decodeUnknownSync(AxisContextCatalog)({
  contexts: [
    { id: "personal", kind: "personal", name: "Personal", createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z" },
    { id: "company", kind: "company", name: "Company", createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z" },
  ],
  projectBindings: [{ contextId: "company", project: { environmentId: "env", projectId: "project" } }],
  providerOwnerships: [
    { contextId: "personal", provider: { environmentId: "env", instanceId: "codex" } },
    { contextId: "company", provider: { environmentId: "env", instanceId: "enterprise" } },
  ],
  providerAccessGrants: [{
    id: "grant",
    ownerContextId: "personal",
    targetContextId: "company",
    provider: { environmentId: "env", instanceId: "codex" },
    status: "active",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    revokedAt: null,
  }],
  capabilities: [],
  workHubSources: [],
});

const decodeRequest = Schema.decodeUnknownSync(AxisProjectScopeRequest);
const request = (provider = "codex") => decodeRequest({
  caller: { environmentId: "env", contextId: "company" },
  operation: "execute" as const,
  scope: { contextId: "company", project: { environmentId: "env", projectId: "project" } },
  provider: { environmentId: "env", instanceId: provider },
});

const dependencies = Layer.mergeAll(
  Layer.succeed(ServerEnvironment, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
    getDescriptor: Effect.die("unused"),
  }),
  Layer.succeed(AxisContextCatalogStore, {
    get: Effect.succeed({ revision: 1, catalog, updatedAt: "2026-09-05T00:00:00.000Z" }),
    replace: () => Effect.die("unused"),
  }),
  Layer.succeed(ProjectionSnapshotQuery, {
    getProjectShellById: () => Effect.succeed(Option.some({} as never)),
  } as never),
);
const testLayer = Layer.merge(
  dependencies,
  Layer.effect(AxisProjectScope, make).pipe(Layer.provide(dependencies)),
);

const layer = it.layer(testLayer);

layer("AxisProjectScope", (it) => {
  it.effect("resolves an owned or explicitly granted provider for a bound Project", () =>
    Effect.gen(function* () {
      const scope = yield* AxisProjectScope;
      const resolved = yield* scope.resolve(request());
      assert.equal(resolved.scope.project.projectId, "project");
      assert.equal(resolved.provider.instanceId, "codex");
      assert.equal(resolved.operation, "execute");
    }),
  );

  it.effect("rejects fabricated environment, context, Project, binding, and provider ids", () =>
    Effect.gen(function* () {
      const scope = yield* AxisProjectScope;
      const cases = [
        [
          "caller_environment_mismatch",
          decodeRequest({
            ...request(),
            caller: { environmentId: "other", contextId: "company" },
          }),
        ],
        [
          "caller_context_mismatch",
          decodeRequest({
            ...request(),
            caller: { environmentId: "env", contextId: "personal" },
          }),
        ],
        [
          "project_not_bound",
          decodeRequest({
            ...request(),
            scope: { ...request().scope, project: { environmentId: "env", projectId: "other" } },
          }),
        ],
        ["provider_not_accessible", request("other")],
      ] as const;
      for (const [reason, input] of cases) {
        const error = yield* Effect.flip(scope.resolve(input));
        assert.instanceOf(error, AxisProjectScopeResolutionError);
        assert.equal(error.reason, reason);
      }
    }),
  );

  it.effect("invalidates removal or rebinding from the current catalog without moving history", () =>
    Effect.gen(function* () {
      const catalogs = Layer.succeed(AxisContextCatalogStore, {
        get: Effect.succeed({
          revision: 2,
          catalog: { ...catalog, projectBindings: [] },
          updatedAt: "2026-09-06T00:00:00.000Z",
        }),
        replace: () => Effect.die("unused"),
      });
      const current = yield* Effect.flip(
        Effect.gen(function* () {
          const resolver = yield* make;
          return yield* resolver.resolve(request());
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ServerEnvironment, {
                getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
                getDescriptor: Effect.die("unused"),
              }),
              catalogs,
              Layer.succeed(ProjectionSnapshotQuery, {
                getProjectShellById: () => Effect.succeed(Option.some({} as never)),
              } as never),
            ),
          ),
        ),
      );
      assert.equal(current.reason, "project_not_bound");
    }),
  );
});

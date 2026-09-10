import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AxisContextProjectScope,
  AxisProjectProfile,
  AxisProjectProfileConflictError,
  AxisProjectProfilePersistenceError,
  AxisProjectProfileValidationError,
  AxisProjectRuleId,
  type AxisProjectTokenEfficiencyPolicy,
  axisContextProjectScopeKey,
  type AxisProjectProfile as AxisProjectProfileType,
  type AxisTypedChange as AxisTypedChangeType,
} from "../../../../../packages/contracts/src/axisProjectProfile.ts";

export {
  AxisProjectProfileConflictError,
  AxisProjectProfilePersistenceError,
  AxisProjectProfileValidationError,
} from "../../../../../packages/contracts/src/axisProjectProfile.ts";

type ProfileRow = {
  readonly revision: unknown;
  readonly profileJson: unknown;
};

type ReadProfile = {
  readonly profile: AxisProjectProfileType;
  readonly persisted: boolean;
};

export type AxisProjectProfileStoreError =
  | AxisProjectProfileConflictError
  | AxisProjectProfilePersistenceError
  | AxisProjectProfileValidationError;

const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(AxisProjectProfile));
const encodeProfile = Schema.encodeEffect(Schema.fromJsonString(AxisProjectProfile));
const decodeRevision = Schema.decodeUnknownEffect(AxisProjectProfile.fields.revision);
const persistenceError = (operation: string) => () =>
  new AxisProjectProfilePersistenceError({ operation });

const emptyProfile = (
  scope: AxisContextProjectScope,
  updatedAt: string,
): AxisProjectProfileType => ({
  scope,
  revision: 0,
  sources: [],
  facts: [],
  rules: [],
  manualDecisions: [],
  workflow: [],
  tokenEfficiencyPolicies: [],
  updatedAt,
});

const replaceById = <Item extends { readonly id: string }>(
  items: ReadonlyArray<Item>,
  item: Item,
): ReadonlyArray<Item> => {
  const index = items.findIndex((existing) => existing.id === item.id);
  return index === -1
    ? [...items, item]
    : items.map((existing, current) => (current === index ? item : existing));
};

const replaceRule = (
  rules: AxisProjectProfileType["rules"],
  rule: AxisProjectProfileType["rules"][number],
): AxisProjectProfileType["rules"] => {
  const index = rules.findIndex(
    (existing) => existing.id === rule.id && existing.origin === rule.origin,
  );
  return index === -1
    ? [...rules, rule]
    : rules.map((existing, current) => (current === index ? rule : existing));
};

const replaceTokenEfficiencyPolicy = (
  policies: ReadonlyArray<AxisProjectTokenEfficiencyPolicy>,
  policy: AxisProjectTokenEfficiencyPolicy,
): ReadonlyArray<AxisProjectTokenEfficiencyPolicy> => {
  const index = policies.findIndex(
    (existing) =>
      existing.providerInstanceId === policy.providerInstanceId && existing.model === policy.model,
  );
  return index === -1
    ? [...policies, policy]
    : policies.map((existing, current) => (current === index ? policy : existing));
};

const applyChanges = (
  profile: AxisProjectProfileType,
  changes: ReadonlyArray<AxisTypedChangeType>,
): Effect.Effect<AxisProjectProfileType, AxisProjectProfileValidationError> => {
  let rules = profile.rules;
  let workflow = profile.workflow;
  let tokenEfficiencyPolicies = profile.tokenEfficiencyPolicies;

  for (const change of changes) {
    switch (change.op) {
      case "set-rule": {
        rules = replaceRule(rules, change.rule);
        break;
      }
      case "remove-rule":
        rules = rules.filter((rule) => rule.id !== change.ruleId);
        break;
      case "set-workflow-step":
        workflow = replaceById(workflow, change.step);
        break;
      case "set-token-efficiency-policy":
        tokenEfficiencyPolicies = replaceTokenEfficiencyPolicy(tokenEfficiencyPolicies, {
          providerInstanceId: change.providerInstanceId,
          model: change.model,
          engine: change.engine,
          mode: change.mode,
        });
        break;
      case "set-provider-instruction":
        return Effect.fail(
          new AxisProjectProfileValidationError({
            message: `Provider instruction ${change.capabilityId} is not representable in an Axis project profile.`,
          }),
        );
    }
  }

  return Effect.succeed({ ...profile, rules, workflow, tokenEfficiencyPolicies });
};

export class AxisProjectProfileStore extends Context.Service<
  AxisProjectProfileStore,
  {
    readonly get: (
      scope: AxisContextProjectScope,
    ) => Effect.Effect<AxisProjectProfileType, AxisProjectProfilePersistenceError>;
    readonly replace: (
      scope: AxisContextProjectScope,
      expectedRevision: number,
      changes: ReadonlyArray<AxisTypedChangeType>,
    ) => Effect.Effect<AxisProjectProfileType, AxisProjectProfileStoreError>;
    readonly replaceSnapshot?: (
      scope: AxisContextProjectScope,
      expectedRevision: number,
      snapshot: AxisProjectProfileType,
    ) => Effect.Effect<AxisProjectProfileType, AxisProjectProfileStoreError>;
    readonly resetOverride: (
      scope: AxisContextProjectScope,
      ruleId: AxisProjectRuleId,
      expectedRevision: number,
    ) => Effect.Effect<AxisProjectProfileType, AxisProjectProfileStoreError>;
  }
>()("t3/axis/projects/AxisProjectProfileStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readRows = (scope: AxisContextProjectScope) => {
    const scopeKey = axisContextProjectScopeKey(scope);
    return sql<ProfileRow>`
      SELECT revision AS "revision", profile_json AS "profileJson"
      FROM axis_project_profiles
      WHERE context_id = ${scope.contextId} AND scope_key = ${scopeKey}
    `;
  };

  const read = (
    scope: AxisContextProjectScope,
    updatedAt: string,
  ): Effect.Effect<ReadProfile, AxisProjectProfilePersistenceError> =>
    readRows(scope).pipe(
      Effect.mapError(
        () => new AxisProjectProfilePersistenceError({ operation: "read project profile" }),
      ),
      Effect.flatMap((rows): Effect.Effect<ReadProfile, AxisProjectProfilePersistenceError> => {
        const row = rows[0];
        if (row === undefined) {
          return Effect.succeed({ profile: emptyProfile(scope, updatedAt), persisted: false });
        }
        return decodeProfile(row.profileJson).pipe(
          Effect.mapError(persistenceError("decode project profile")),
          Effect.flatMap((profile) =>
            decodeRevision(row.revision).pipe(
              Effect.mapError(persistenceError("decode project profile revision")),
              Effect.flatMap((revision) =>
                profile.scope.contextId === scope.contextId &&
                axisContextProjectScopeKey(profile.scope) === axisContextProjectScopeKey(scope) &&
                profile.revision === revision
                  ? Effect.succeed({ profile, persisted: true })
                  : Effect.fail(
                      new AxisProjectProfilePersistenceError({
                        operation: "validate project profile row",
                      }),
                    ),
              ),
            ),
          ),
        );
      }),
    );

  const get: AxisProjectProfileStore["Service"]["get"] = (scope) =>
    Effect.gen(function* () {
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      return (yield* read(scope, updatedAt)).profile;
    });

  const save = (
    scope: AxisContextProjectScope,
    expectedRevision: number,
    next: (
      current: AxisProjectProfileType,
    ) => Effect.Effect<AxisProjectProfileType, AxisProjectProfileValidationError>,
  ): Effect.Effect<AxisProjectProfileType, AxisProjectProfileStoreError> =>
    Effect.gen(function* () {
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      const result = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* read(scope, updatedAt);
            if (current.profile.revision !== expectedRevision) {
              return { saved: undefined, actualRevision: current.profile.revision } as const;
            }

            const changed = yield* next(current.profile);
            const profile = { ...changed, revision: expectedRevision + 1, updatedAt };
            const profileJson = yield* encodeProfile(profile).pipe(
              Effect.mapError(persistenceError("encode project profile")),
            );
            const scopeKey = axisContextProjectScopeKey(scope);
            const rows = yield* sql<{ readonly profileJson: unknown }>`
            INSERT INTO axis_project_profiles (
              context_id, environment_id, project_id, scope_key, revision,
              profile_json, created_at, updated_at
            ) VALUES (
              ${scope.contextId}, ${scope.project.environmentId}, ${scope.project.projectId},
              ${scopeKey}, ${profile.revision}, ${profileJson}, ${updatedAt}, ${updatedAt}
            )
            ON CONFLICT (context_id, scope_key) DO UPDATE SET
              revision = excluded.revision,
              profile_json = excluded.profile_json,
              updated_at = excluded.updated_at
            WHERE axis_project_profiles.revision = ${expectedRevision}
            RETURNING profile_json AS "profileJson"
          `;
            return rows[0] === undefined
              ? ({ saved: undefined, actualRevision: undefined } as const)
              : ({ saved: rows[0].profileJson, actualRevision: undefined } as const);
          }),
        )
        .pipe(
          Effect.catchTag("SqlError", () =>
            Effect.fail(
              new AxisProjectProfilePersistenceError({ operation: "save project profile" }),
            ),
          ),
        );

      if (result.saved !== undefined) {
        return yield* decodeProfile(result.saved).pipe(
          Effect.mapError(persistenceError("decode saved project profile")),
        );
      }

      const current = yield* read(scope, updatedAt);
      return yield* new AxisProjectProfileConflictError({
        scope,
        expectedRevision,
        actualRevision: current.profile.revision,
      });
    });

  const replace: AxisProjectProfileStore["Service"]["replace"] = (
    scope,
    expectedRevision,
    changes,
  ) => save(scope, expectedRevision, (profile) => applyChanges(profile, changes));

  const replaceSnapshot: AxisProjectProfileStore["Service"]["replaceSnapshot"] = (
    scope,
    expectedRevision,
    snapshot,
  ) =>
    save(scope, expectedRevision, () =>
      Schema.decodeUnknownEffect(AxisProjectProfile)(snapshot).pipe(
        Effect.mapError(
          () =>
            new AxisProjectProfileValidationError({
              message: "The project profile snapshot is invalid.",
            }),
        ),
        Effect.flatMap((decoded) =>
          decoded.scope.contextId === scope.contextId &&
          axisContextProjectScopeKey(decoded.scope) === axisContextProjectScopeKey(scope)
            ? Effect.succeed({ ...decoded, scope })
            : Effect.fail(
                new AxisProjectProfileValidationError({
                  message: "The project profile snapshot targets another project.",
                }),
              ),
        ),
      ),
    );

  const resetOverride: AxisProjectProfileStore["Service"]["resetOverride"] = (
    scope,
    ruleId,
    expectedRevision,
  ) =>
    save(scope, expectedRevision, (profile) =>
      Effect.succeed({
        ...profile,
        rules: profile.rules.filter((rule) => !(rule.id === ruleId && rule.origin === "manual")),
      }),
    );

  return {
    get,
    replace,
    replaceSnapshot,
    resetOverride,
  } satisfies AxisProjectProfileStore["Service"];
});

export const layer = Layer.effect(AxisProjectProfileStore, make);

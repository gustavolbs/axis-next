// @effect-diagnostics nodeBuiltinImport:off - command digests are persistence keys.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AxisOnboardingApplyInput,
  AxisOnboardingCandidateRuleId,
  AxisOnboardingProgress,
  AxisOnboardingRun,
  type AxisOnboardingRun as AxisOnboardingRunType,
} from "../../../../../packages/contracts/src/axisOnboarding.ts";
import {
  AxisProjectProfile,
  AxisProjectRuleId,
  axisProjectScopeKey,
  type AxisProjectProfile as AxisProjectProfileType,
} from "../../../../../packages/contracts/src/axisProjectProfile.ts";
import * as AxisProjectProfileStore from "../projects/AxisProjectProfileStore.ts";
import { applyAxisOnboarding, AxisOnboardingApplyError } from "./AxisOnboardingApply.ts";
import * as AxisOnboardingStore from "./AxisOnboardingStore.ts";

export type AxisOnboardingPersistenceInput = AxisOnboardingApplyInput & {
  readonly decidedAt: string;
};
type AxisOnboardingProgressType = typeof AxisOnboardingProgress.Type;

export interface AxisOnboardingRunSnapshot {
  readonly run: AxisOnboardingRunType;
  readonly progress: AxisOnboardingProgressType;
}

export interface AxisOnboardingPersistenceResult {
  readonly run: AxisOnboardingRunSnapshot;
  readonly profile: AxisProjectProfileType;
  readonly invalidatedRuleIds: ReadonlyArray<AxisProjectRuleId>;
  readonly acceptedCandidateIds: ReadonlyArray<
    AxisOnboardingRunType["candidateRules"][number]["id"]
  >;
}

const responseSchema = Schema.Struct({
  run: Schema.Struct({ run: AxisOnboardingRun, progress: AxisOnboardingProgress }),
  profile: AxisProjectProfile,
  invalidatedRuleIds: Schema.Array(AxisProjectRuleId),
  acceptedCandidateIds: Schema.Array(AxisOnboardingCandidateRuleId),
});
const encodeResponse = Schema.encodeEffect(Schema.fromJsonString(responseSchema));
const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(responseSchema));

type ApplicationRow = {
  readonly runId: unknown;
  readonly requestDigest: unknown;
  readonly responseJson: unknown;
};

// ProfileStore owns the context-qualified profile key; this helper only writes
// the run/application tables, whose existing key is project-qualified.
const runScopeKey = (input: AxisOnboardingPersistenceInput) =>
  axisProjectScopeKey(input.scope.project);
const digest = (input: AxisOnboardingPersistenceInput) =>
  `sha256:${NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        scope: input.scope,
        runId: input.runId,
        expectedProfileRevision: input.expectedProfileRevision,
        decisions: input.decisions,
      }),
      "utf8",
    )
    .digest("hex")}`;

const progressFor = (run: AxisOnboardingRunType): AxisOnboardingProgressType =>
  run.status === "completed"
    ? {
        stage: "completed",
        completedSteps: 3,
        totalSteps: 3,
        message: "Onboarding analysis completed and is ready for review.",
      }
    : {
        stage: "ready",
        completedSteps: 3,
        totalSteps: 3,
        message: "Onboarding candidates are ready for review.",
      };

/** Applies profile, run decisions, and the replay ledger in one SQLite transaction. */
export const applyAxisOnboardingPersistence = Effect.fn("applyAxisOnboardingPersistence")(
  function* (input: AxisOnboardingPersistenceInput) {
    const sql = yield* SqlClient.SqlClient;
    const runs = yield* AxisOnboardingStore.AxisOnboardingStore;
    const profiles = yield* AxisProjectProfileStore.AxisProjectProfileStore;
    const requestDigest = digest(input);
    const key = runScopeKey(input);

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const previous = yield* sql<ApplicationRow>`
        SELECT run_id AS "runId", request_digest AS "requestDigest", response_json AS "responseJson"
        FROM axis_onboarding_applications
        WHERE context_id = ${input.scope.contextId} AND scope_key = ${key} AND command_id = ${input.commandId}
      `;
          if (previous[0] !== undefined) {
            if (previous[0].runId !== input.runId || previous[0].requestDigest !== requestDigest) {
              return yield* new AxisOnboardingStore.AxisOnboardingCommandConflictError({
                commandId: input.commandId,
              });
            }
            return yield* decodeResponse(previous[0].responseJson).pipe(
              Effect.mapError(
                () =>
                  new AxisOnboardingStore.AxisOnboardingPersistenceError({
                    operation: "decode onboarding application",
                  }),
              ),
            );
          }

          const runOption = yield* runs.get(input.scope, input.runId);
          if (Option.isNone(runOption)) {
            return yield* Effect.fail(
              new AxisOnboardingApplyError(
                "invalid_run",
                `Onboarding run ${input.runId} was not found in this project.`,
              ),
            );
          }
          const profile = yield* profiles.get(input.scope);
          const result = yield* Effect.try({
            try: () =>
              applyAxisOnboarding({
                profile,
                run: runOption.value,
                decisions: input.decisions,
                expectedProfileRevision: input.expectedProfileRevision,
                decidedAt: input.decidedAt,
              }),
            catch: (cause) =>
              cause instanceof AxisOnboardingApplyError
                ? cause
                : new AxisOnboardingApplyError(
                    "invalid_run",
                    "The onboarding result could not be applied.",
                  ),
          });
          if (profiles.replaceSnapshot === undefined) {
            return yield* new AxisProjectProfileStore.AxisProjectProfilePersistenceError({
              operation: "replace project profile snapshot",
            });
          }
          const savedProfile = yield* profiles.replaceSnapshot(
            input.scope,
            input.expectedProfileRevision,
            result.profile,
          );
          const savedRun = { ...runOption.value, decisions: [...input.decisions] };
          yield* runs.save(savedRun);
          const response: AxisOnboardingPersistenceResult = {
            run: { run: savedRun, progress: progressFor(savedRun) },
            profile: savedProfile,
            invalidatedRuleIds: result.invalidatedRuleIds,
            acceptedCandidateIds: result.acceptedCandidateIds,
          };
          const responseJson = yield* encodeResponse(response).pipe(
            Effect.mapError(
              () =>
                new AxisOnboardingStore.AxisOnboardingPersistenceError({
                  operation: "encode onboarding application",
                }),
            ),
          );
          yield* sql`
        INSERT INTO axis_onboarding_applications
          (context_id, scope_key, run_id, command_id, request_digest, response_json, created_at)
        VALUES
          (${input.scope.contextId}, ${key}, ${input.runId}, ${input.commandId}, ${requestDigest}, ${responseJson}, datetime('now'))
      `;
          return response;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", () =>
          Effect.fail(
            new AxisOnboardingStore.AxisOnboardingPersistenceError({
              operation: "apply onboarding",
            }),
          ),
        ),
      );
  },
);

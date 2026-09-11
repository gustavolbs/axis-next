/**
 * H05 — AxisLearningOutcomes.
 *
 * Reconciles learning outcomes from a task, its persisted evidence and the
 * versions actually used during execution. Idempotent on
 * (scope, commandId); retries return the existing row without rewriting the
 * outcome timestamp.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import {
  AxisContextProjectScope,
  AxisLearningActivationState,
  AxisLearningVersionId,
  CommandId,
  TrimmedNonEmptyString,
  axisProjectScopeKey,
} from "@t3tools/contracts";

const MAX_SUMMARY_LENGTH = 2_000;
const MAX_NOTE_LENGTH = 2_000;
const MAX_VERSIONS = 200;
const projectScopeKeyFor = (scope: AxisContextProjectScope) => axisProjectScopeKey(scope.project);

export const AxisLearningOutcomeSignalSchema = Schema.Literals([
  "applied",
  "rolled-back",
  "no-effect",
  "blocked",
]);
export type AxisLearningOutcomeSignal = typeof AxisLearningOutcomeSignalSchema.Type;

export const AxisLearningOutcomeInputSchema = Schema.Struct({
  scope: AxisContextProjectScope,
  taskId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  commandId: CommandId,
  signal: AxisLearningOutcomeSignalSchema,
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_SUMMARY_LENGTH)),
  versionIds: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(128))).check(
    Schema.isMaxLength(MAX_VERSIONS),
  ),
  note: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_NOTE_LENGTH))),
  observedAt: TrimmedNonEmptyString,
});
export type AxisLearningOutcomeInput = typeof AxisLearningOutcomeInputSchema.Type;

export const AxisLearningOutcomeRecordSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  scope: AxisContextProjectScope,
  taskId: Schema.String,
  commandId: CommandId,
  signal: AxisLearningOutcomeSignalSchema,
  summary: Schema.String,
  versionIds: Schema.Array(Schema.String),
  note: Schema.NullOr(Schema.String),
  observedAt: Schema.String,
  recordedAt: Schema.String,
});
export type AxisLearningOutcomeRecord = typeof AxisLearningOutcomeRecordSchema.Type;

export class AxisLearningOutcomesError extends Schema.TaggedErrorClass<AxisLearningOutcomesError>()(
  "AxisLearningOutcomesError",
  {
    reason: Schema.Literals(["invalid_input", "scope_mismatch", "duplicate", "persistence_failed"]),
    message: Schema.String,
  },
) {}

type OutcomeRow = {
  readonly id: unknown;
  readonly scopeKey: unknown;
  readonly taskId: unknown;
  readonly commandId: unknown;
  readonly signal: unknown;
  readonly summary: unknown;
  readonly versionIdsJson: unknown;
  readonly note: unknown;
  readonly observedAt: unknown;
  readonly createdAt: unknown;
  readonly contextId: unknown;
};

const error = (reason: AxisLearningOutcomesError["reason"], message: string) =>
  new AxisLearningOutcomesError({ reason, message });

const fingerprintFor = (input: AxisLearningOutcomeInput): string => {
  const payload = JSON.stringify({
    scope: projectScopeKeyFor(input.scope),
    taskId: input.taskId,
    commandId: input.commandId,
    signal: input.signal,
    summary: input.summary,
    versionIds: [...input.versionIds].sort(),
    note: input.note,
    observedAt: input.observedAt,
  });
  return `sha256:${NodeCrypto.createHash("sha256").update(payload, "utf8").digest("hex")}`;
};

export const recordAxisLearningOutcome = (
  input: AxisLearningOutcomeInput,
): Effect.Effect<AxisLearningOutcomeRecord, AxisLearningOutcomesError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    if (input.versionIds.length === 0) {
      return yield* error(
        "invalid_input",
        "At least one learning version id must be provided to record an outcome.",
      );
    }
    const fingerprint = fingerprintFor(input);
    const outcomeId = `axis-outcome-${NodeCrypto.createHash("sha256")
      .update(`${input.scope.contextId}|${projectScopeKeyFor(input.scope)}|${fingerprint}`)
      .digest("hex")}`;
    const sql = yield* SqlClient.SqlClient;
    const versionIdsJson = JSON.stringify([...new Set(input.versionIds)].sort());
    const createdAt = DateTime.formatIso(DateTime.nowUnsafe());
    const rows = yield* sql<OutcomeRow>`
      INSERT INTO axis_learning_outcomes (
        id, context_id, scope_key, task_id, command_id,
        signal, summary, version_ids_json, note,
        observed_at, created_at
      )
      VALUES (
        ${outcomeId},
        ${input.scope.contextId},
        ${projectScopeKeyFor(input.scope)},
        ${input.taskId},
        ${input.commandId},
        ${input.signal},
        ${input.summary},
        ${versionIdsJson},
        ${input.note},
        ${input.observedAt},
        ${createdAt}
      )
      ON CONFLICT(context_id, scope_key, command_id) DO UPDATE
      SET
        signal = excluded.signal,
        summary = excluded.summary,
        version_ids_json = excluded.version_ids_json,
        note = excluded.note,
        observed_at = excluded.observed_at
      RETURNING
        id AS id,
        context_id AS contextId,
        scope_key AS scopeKey,
        task_id AS taskId,
        command_id AS commandId,
        signal,
        summary,
        version_ids_json AS versionIdsJson,
        note,
        observed_at AS observedAt,
        created_at AS createdAt
    `.pipe(
      Effect.mapError(() => error("persistence_failed", "Cannot persist learning outcome row.")),
    );
    const written = rows[0];
    if (written === undefined) {
      return yield* error("persistence_failed", "Insert returned no learning outcome row.");
    }
    const versionIds = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(Schema.String)),
    )(written.versionIdsJson).pipe(
      Effect.mapError(() => error("persistence_failed", "Cannot decode stored version ids.")),
    );
    return {
      id: written.id as string,
      scope: input.scope,
      taskId: written.taskId as string,
      commandId: written.commandId as CommandId,
      signal: written.signal as AxisLearningOutcomeSignal,
      summary: written.summary as string,
      versionIds,
      note: written.note as string | null,
      observedAt: written.observedAt as string,
      recordedAt: written.createdAt as string,
    };
  });

export const summarizeAxisLearningOutcomes = (
  records: ReadonlyArray<AxisLearningOutcomeRecord>,
): {
  readonly applied: number;
  readonly rolledBack: number;
  readonly blocked: number;
  readonly noEffect: number;
} => {
  let applied = 0;
  let rolledBack = 0;
  let blocked = 0;
  let noEffect = 0;
  for (const record of records) {
    if (record.signal === "applied") applied += 1;
    else if (record.signal === "rolled-back") rolledBack += 1;
    else if (record.signal === "blocked") blocked += 1;
    else noEffect += 1;
  }
  return { applied, rolledBack, blocked, noEffect };
};

export const toActiveVersionId = (
  state: AxisLearningActivationState,
): AxisLearningVersionId | null => state.versionId;

export const outcomeFingerprintFor = (input: AxisLearningOutcomeInput): string =>
  fingerprintFor(input);

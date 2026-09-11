/**
 * W04 — AxisVerificationEvidence.
 *
 * Verification evidence recorded by a task step. Each row is keyed by
 * (scope, taskId, stepId, commandId) and the writer is responsible for
 * keeping `coveredFiles` and `observedRevision` accurate. The store
 * detects idempotent re-records (identical payload returns the original
 * row) and rejects divergent payloads as duplicates so an unstaged
 * retry never overwrites a real observation.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import {
  AxisContextProjectScope,
  AxisTaskId,
  AxisTaskStepId,
  CommandId,
  TrimmedNonEmptyString,
  axisProjectScopeKey,
} from "@t3tools/contracts";

const MAX_COVERED_FILES = 200;
const MAX_PATH_LENGTH = 4096;
const MAX_SUMMARY_LENGTH = 2_000;
const MAX_REASON_LENGTH = 2_000;
const MAX_COMMAND_LENGTH = 8_000;

const projectScopeKeyFor = (scope: AxisContextProjectScope) => axisProjectScopeKey(scope.project);

export type AxisVerificationOutcome = "passed" | "failed" | "not-applicable" | "not-run";

export const AxisVerificationOutcomeSchema = Schema.Literals([
  "passed",
  "failed",
  "not-applicable",
  "not-run",
]);
export type AxisVerificationOutcomeType = typeof AxisVerificationOutcomeSchema.Type;

export const AxisVerificationEvidenceSchema = Schema.Struct({
  outcome: AxisVerificationOutcomeSchema,
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_COMMAND_LENGTH)),
  exitCode: Schema.NullOr(Schema.Int),
  observedAt: TrimmedNonEmptyString,
  observedRevision: Schema.Int,
  coveredFiles: Schema.Array(
    TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_PATH_LENGTH)),
  ).check(Schema.isMaxLength(MAX_COVERED_FILES)),
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_SUMMARY_LENGTH)),
  source: Schema.Literals(["auto", "manual"]),
  reason: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_REASON_LENGTH))),
});
export type AxisVerificationEvidenceType = typeof AxisVerificationEvidenceSchema.Type;

export const AxisVerificationEvidenceRequestSchema = Schema.Struct({
  scope: AxisContextProjectScope,
  taskId: AxisTaskId,
  stepId: AxisTaskStepId,
  commandId: CommandId,
  evidence: AxisVerificationEvidenceSchema,
});
export type AxisVerificationEvidenceRequest = typeof AxisVerificationEvidenceRequestSchema.Type;

export const AxisVerificationEvidenceLookupSchema = Schema.Struct({
  scope: AxisContextProjectScope,
  taskId: AxisTaskId,
  stepId: AxisTaskStepId,
});
export type AxisVerificationEvidenceLookup = typeof AxisVerificationEvidenceLookupSchema.Type;

export const AxisVerificationEvidenceInvalidateSchema = Schema.Struct({
  scope: AxisContextProjectScope,
  taskId: AxisTaskId,
  currentRevision: Schema.Int,
});
export type AxisVerificationEvidenceInvalidate =
  typeof AxisVerificationEvidenceInvalidateSchema.Type;

export class AxisVerificationEvidenceError extends Schema.TaggedErrorClass<AxisVerificationEvidenceError>()(
  "AxisVerificationEvidenceError",
  {
    reason: Schema.Literals([
      "invalid_input",
      "scope_mismatch",
      "command_missing",
      "stale_evidence",
      "covered_files_changed",
      "duplicate",
      "persistence_failed",
    ]),
    message: Schema.String,
  },
) {}

type EvidenceRow = {
  readonly contextId: unknown;
  readonly scopeKey: unknown;
  readonly taskId: unknown;
  readonly stepId: unknown;
  readonly commandId: unknown;
  readonly outcome: unknown;
  readonly command: unknown;
  readonly exitCode: unknown;
  readonly observedAt: unknown;
  readonly observedRevision: unknown;
  readonly coveredFilesJson: unknown;
  readonly summary: unknown;
  readonly source: unknown;
  readonly reason: unknown;
  readonly createdAt: unknown;
};

const error = (reason: AxisVerificationEvidenceError["reason"], message: string) =>
  new AxisVerificationEvidenceError({ reason, message });

const evidenceDigest = (input: AxisVerificationEvidenceType) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        outcome: input.outcome,
        command: input.command,
        exitCode: input.exitCode,
        observedAt: input.observedAt,
        observedRevision: input.observedRevision,
        coveredFiles: [...input.coveredFiles].sort(),
        summary: input.summary,
        source: input.source,
        reason: input.reason,
      }),
      "utf8",
    )
    .digest("hex");

const normalizeCoveredFiles = (files: ReadonlyArray<string>) => [...new Set(files)].sort();

const semanticEquals = (
  left: AxisVerificationEvidenceType,
  right: AxisVerificationEvidenceType,
): boolean => evidenceDigest(left) === evidenceDigest(right);

const requireCommandPresent = (
  evidence: AxisVerificationEvidenceType,
): Effect.Effect<void, AxisVerificationEvidenceError> =>
  evidence.command.trim().length === 0
    ? Effect.fail(error("command_missing", "Verification evidence requires a non-empty command."))
    : Effect.void;

const requireCoveredFiles = (
  evidence: AxisVerificationEvidenceType,
): Effect.Effect<void, AxisVerificationEvidenceError> =>
  evidence.outcome === "passed" || evidence.outcome === "failed"
    ? evidence.coveredFiles.length === 0
      ? Effect.fail(
          error(
            "invalid_input",
            "Passed or failed verification evidence must list the files it covered.",
          ),
        )
      : Effect.void
    : Effect.void;

const decodeEvidenceRow = (row: EvidenceRow) =>
  Effect.gen(function* () {
    const raw = row.coveredFilesJson;
    if (typeof raw !== "string") {
      return yield* error(
        "persistence_failed",
        `Cannot decode stored verification evidence: coveredFilesJson is not a string (${typeof raw}).`,
      );
    }
    const coveredFiles = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(Schema.String)),
    )(raw).pipe(
      Effect.mapError((cause) =>
        error(
          "persistence_failed",
          `Cannot decode stored verification evidence (${String(cause)}).`,
        ),
      ),
    );
    return {
      outcome: row.outcome as AxisVerificationOutcome,
      command: row.command as string,
      exitCode: row.exitCode as number | null,
      observedAt: row.observedAt as string,
      observedRevision: row.observedRevision as number,
      coveredFiles,
      summary: row.summary as string,
      source: row.source as "auto" | "manual",
      reason: row.reason as string | null,
    } satisfies AxisVerificationEvidenceType;
  });

const decodeCreatedAt = (row: EvidenceRow): string => row.createdAt as string;

export interface AxisVerificationEvidenceRecordResult {
  readonly evidence: AxisVerificationEvidenceType;
  readonly createdAt: string;
}

export const recordAxisVerificationEvidence = (
  input: AxisVerificationEvidenceRequest,
): Effect.Effect<
  AxisVerificationEvidenceRecordResult,
  AxisVerificationEvidenceError,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    yield* requireCommandPresent(input.evidence);
    yield* requireCoveredFiles(input.evidence);
    const sql = yield* SqlClient.SqlClient;
    const coveredFiles = normalizeCoveredFiles(input.evidence.coveredFiles);
    const coveredFilesJson = JSON.stringify(coveredFiles);
    const createdAtDate = yield* DateTime.now;
    const createdAt = DateTime.formatIso(createdAtDate);
    const rows = yield* sql<EvidenceRow>`
      INSERT INTO axis_verification_evidence (
        context_id, scope_key, task_id, step_id, command_id,
        outcome, command, exit_code, observed_at, observed_revision,
        covered_files_json, summary, source, reason, created_at
      )
      VALUES (
        ${input.scope.contextId},
        ${projectScopeKeyFor(input.scope)},
        ${input.taskId},
        ${input.stepId},
        ${input.commandId},
        ${input.evidence.outcome},
        ${input.evidence.command},
        ${input.evidence.exitCode},
        ${input.evidence.observedAt},
        ${input.evidence.observedRevision},
        ${coveredFilesJson},
        ${input.evidence.summary},
        ${input.evidence.source},
        ${input.evidence.reason},
        ${createdAt}
      )
      ON CONFLICT(context_id, scope_key, task_id, step_id, command_id) DO NOTHING
      RETURNING
        context_id AS contextId,
        scope_key AS scopeKey,
        task_id AS taskId,
        step_id AS stepId,
        command_id AS commandId,
        outcome,
        command,
        exit_code AS exitCode,
        observed_at AS observedAt,
        observed_revision AS observedRevision,
        covered_files_json AS coveredFilesJson,
        summary,
        source,
        reason,
        created_at AS createdAt
    `.pipe(
      Effect.mapError(() =>
        error("persistence_failed", "Cannot persist verification evidence row."),
      ),
    );
    const written = rows[0];
    if (written !== undefined) {
      const evidence = yield* decodeEvidenceRow(written);
      return { evidence, createdAt: decodeCreatedAt(written) };
    }
    const existing = yield* sql<EvidenceRow>`
      SELECT
        context_id AS contextId,
        scope_key AS scopeKey,
        task_id AS taskId,
        step_id AS stepId,
        command_id AS commandId,
        outcome,
        command,
        exit_code AS exitCode,
        observed_at AS observedAt,
        observed_revision AS observedRevision,
        covered_files_json AS coveredFilesJson,
        summary,
        source,
        reason,
        created_at AS createdAt
      FROM axis_verification_evidence
      WHERE context_id = ${input.scope.contextId}
        AND scope_key = ${projectScopeKeyFor(input.scope)}
        AND task_id = ${input.taskId}
        AND step_id = ${input.stepId}
        AND command_id = ${input.commandId}
    `.pipe(
      Effect.mapError(() =>
        error("persistence_failed", "Cannot read existing verification evidence row."),
      ),
    );
    const previous = existing[0];
    if (previous === undefined) {
      return yield* error(
        "persistence_failed",
        "Insert returned no row and the existing evidence is missing.",
      );
    }
    const previousEvidence = yield* decodeEvidenceRow(previous);
    if (!semanticEquals(previousEvidence, { ...input.evidence, coveredFiles })) {
      return yield* error(
        "duplicate",
        "A different verification evidence row already exists for this command and step.",
      );
    }
    return { evidence: previousEvidence, createdAt: decodeCreatedAt(previous) };
  });

export const getAxisVerificationEvidence = (
  input: AxisVerificationEvidenceLookup,
): Effect.Effect<
  AxisVerificationEvidenceRecordResult | null,
  AxisVerificationEvidenceError,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<EvidenceRow>`
      SELECT
        context_id AS contextId,
        scope_key AS scopeKey,
        task_id AS taskId,
        step_id AS stepId,
        command_id AS commandId,
        outcome,
        command,
        exit_code AS exitCode,
        observed_at AS observedAt,
        observed_revision AS observedRevision,
        covered_files_json AS coveredFilesJson,
        summary,
        source,
        reason,
        created_at AS createdAt
      FROM axis_verification_evidence
      WHERE context_id = ${input.scope.contextId}
        AND scope_key = ${projectScopeKeyFor(input.scope)}
        AND task_id = ${input.taskId}
        AND step_id = ${input.stepId}
      ORDER BY datetime(created_at) DESC, command_id DESC
      LIMIT 1
    `.pipe(
      Effect.mapError(() => error("persistence_failed", "Cannot read verification evidence row.")),
    );
    const row = rows[0];
    if (row === undefined) return null;
    const evidence = yield* decodeEvidenceRow(row);
    return { evidence, createdAt: decodeCreatedAt(row) };
  });

export const invalidateStaleAxisVerificationEvidence = (
  input: AxisVerificationEvidenceInvalidate,
): Effect.Effect<number, AxisVerificationEvidenceError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    if (input.currentRevision < 0) {
      return yield* error("invalid_input", "currentRevision must be a non-negative integer.");
    }
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      DELETE FROM axis_verification_evidence
      WHERE context_id = ${input.scope.contextId}
        AND scope_key = ${projectScopeKeyFor(input.scope)}
        AND task_id = ${input.taskId}
        AND observed_revision < ${input.currentRevision}
    `.pipe(
      Effect.mapError(() =>
        error("persistence_failed", "Cannot invalidate stale verification evidence rows."),
      ),
    );
    const countRows = yield* sql<{ readonly count: number }>`
      SELECT changes() AS count
    `.pipe(
      Effect.mapError(() => error("persistence_failed", "Cannot read invalidated row count.")),
    );
    return countRows[0]?.count ?? 0;
  });

export const coveredFilesChanged = (input: {
  readonly evidence: AxisVerificationEvidenceType;
  readonly currentSnapshot: ReadonlyArray<{ readonly path: string; readonly digest: string }>;
}): boolean => {
  if (input.evidence.coveredFiles.length === 0) return false;
  const snapshotByPath = new Map<string, string>();
  for (const file of input.currentSnapshot) snapshotByPath.set(file.path, file.digest);
  for (const path of input.evidence.coveredFiles) {
    if (!snapshotByPath.has(path)) return true;
  }
  return false;
};

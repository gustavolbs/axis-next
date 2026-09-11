/**
 * W05 — AxisReviewEvidence.
 *
 * Reviews are bound to a concrete checkpoint diff and revalidated against the
 * current Git/working tree state at publish time. A review recorded against
 * `base/head/digest` that no longer matches the current diff is reported as
 * stale; the writer decides whether to re-record (new commandId required) or
 * reject the publish.
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
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  axisProjectScopeKey,
} from "@t3tools/contracts";

const MAX_PATH_LENGTH = 4096;
const MAX_SUMMARY_LENGTH = 4_000;
const MAX_NOTE_LENGTH = 4_000;
const MAX_FINDINGS = 200;
const projectScopeKeyFor = (scope: AxisContextProjectScope) => axisProjectScopeKey(scope.project);

export type AxisReviewFindingSeverity = "blocker" | "suggestion";

export const AxisReviewFindingSeveritySchema = Schema.Literals(["blocker", "suggestion"]);
export type AxisReviewFindingSeverityType = typeof AxisReviewFindingSeveritySchema.Type;

export const AxisReviewFindingSchema = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  severity: AxisReviewFindingSeveritySchema,
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_SUMMARY_LENGTH)),
  evidence: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_SUMMARY_LENGTH)),
});
export type AxisReviewFinding = typeof AxisReviewFindingSchema.Type;

export const AxisReviewEvidenceRequestSchema = Schema.Struct({
  scope: AxisContextProjectScope,
  taskId: AxisTaskId,
  stepId: AxisTaskStepId,
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  baseSha: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  headSha: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  diffDigest: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  filesCovered: Schema.Array(
    TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_PATH_LENGTH)),
  ).check(Schema.isMaxLength(MAX_FINDINGS)),
  rulesUsed: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(512))).check(
    Schema.isMaxLength(MAX_FINDINGS),
  ),
  findings: Schema.Array(AxisReviewFindingSchema).check(Schema.isMaxLength(MAX_FINDINGS)),
  reviewer: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  note: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_NOTE_LENGTH))),
});
export type AxisReviewEvidenceRequest = typeof AxisReviewEvidenceRequestSchema.Type;

export const AxisReviewRevalidateSchema = Schema.Struct({
  scope: AxisContextProjectScope,
  taskId: AxisTaskId,
  stepId: AxisTaskStepId,
  currentDiffDigest: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  currentHeadSha: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type AxisReviewRevalidate = typeof AxisReviewRevalidateSchema.Type;

export const AxisReviewSnapshotSchema = Schema.Struct({
  taskId: AxisTaskId,
  stepId: AxisTaskStepId,
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  baseSha: Schema.String,
  headSha: Schema.String,
  diffDigest: Schema.String,
  filesCovered: Schema.Array(Schema.String),
  rulesUsed: Schema.Array(Schema.String),
  findings: Schema.Array(AxisReviewFindingSchema),
  reviewer: Schema.String,
  note: Schema.NullOr(Schema.String),
  recordedAt: Schema.String,
});
export type AxisReviewSnapshot = typeof AxisReviewSnapshotSchema.Type;

export class AxisReviewEvidenceError extends Schema.TaggedErrorClass<AxisReviewEvidenceError>()(
  "AxisReviewEvidenceError",
  {
    reason: Schema.Literals([
      "invalid_input",
      "scope_mismatch",
      "stale_review",
      "head_changed",
      "duplicate",
      "persistence_failed",
      "not_found",
    ]),
    message: Schema.String,
  },
) {}

type ReviewRow = {
  readonly contextId: unknown;
  readonly scopeKey: unknown;
  readonly taskId: unknown;
  readonly stepId: unknown;
  readonly commandId: unknown;
  readonly threadId: unknown;
  readonly turnId: unknown;
  readonly baseSha: unknown;
  readonly headSha: unknown;
  readonly diffDigest: unknown;
  readonly filesJson: unknown;
  readonly rulesJson: unknown;
  readonly findingsJson: unknown;
  readonly reviewer: unknown;
  readonly note: unknown;
  readonly createdAt: unknown;
};

const error = (reason: AxisReviewEvidenceError["reason"], message: string) =>
  new AxisReviewEvidenceError({ reason, message });

const decodeJsonArray = (raw: unknown, message: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(raw).pipe(
    Effect.mapError(() => error("persistence_failed", message)),
  );

const decodeFindings = (raw: unknown) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(AxisReviewFindingSchema)))(
    raw,
  ).pipe(Effect.mapError(() => error("persistence_failed", "Cannot decode stored findings.")));

const snapshotDigest = (input: AxisReviewEvidenceRequest) =>
  // JSON.stringify on a structured object is acceptable here because we feed the
  // payload straight into SHA-256; we never round-trip the JSON.
  // eslint-disable-next-line effect/preferSchemaOverJson
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        contextId: input.scope.contextId,
        scope: projectScopeKeyFor(input.scope),
        taskId: input.taskId,
        stepId: input.stepId,
        commandId: input.commandId,
        threadId: input.threadId,
        turnId: input.turnId,
        baseSha: input.baseSha,
        headSha: input.headSha,
        diffDigest: input.diffDigest,
        filesCovered: [...input.filesCovered].sort(),
        rulesUsed: [...input.rulesUsed].sort(),
        findings: [...input.findings].sort((a, b) => a.id.localeCompare(b.id)),
        reviewer: input.reviewer,
        note: input.note,
      }),
      "utf8",
    )
    .digest("hex");

const decodeRow = (row: ReviewRow) =>
  Effect.gen(function* () {
    const filesCovered = yield* decodeJsonArray(row.filesJson, "Cannot decode stored files.");
    const rulesUsed = yield* decodeJsonArray(row.rulesJson, "Cannot decode stored rules.");
    const findings = yield* decodeFindings(row.findingsJson);
    return {
      taskId: row.taskId as AxisTaskId,
      stepId: row.stepId as AxisTaskStepId,
      commandId: row.commandId as CommandId,
      threadId: row.threadId as ThreadId,
      turnId: row.turnId as TurnId,
      baseSha: row.baseSha as string,
      headSha: row.headSha as string,
      diffDigest: row.diffDigest as string,
      filesCovered,
      rulesUsed,
      findings,
      reviewer: row.reviewer as string,
      note: row.note as string | null,
      recordedAt: row.createdAt as string,
    } satisfies AxisReviewSnapshot;
  });

export interface AxisReviewEvidenceRecordResult {
  readonly snapshot: AxisReviewSnapshot;
  readonly alreadyRecorded: boolean;
}

export const recordAxisReviewEvidence = (
  input: AxisReviewEvidenceRequest,
): Effect.Effect<AxisReviewEvidenceRecordResult, AxisReviewEvidenceError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    if (input.findings.length === 0 && input.note === null) {
      return yield* error(
        "invalid_input",
        "Review must include findings or a note when no blockers are reported.",
      );
    }
    const sql = yield* SqlClient.SqlClient;
    const filesCodec = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
    const rulesCodec = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
    const findingsCodec = Schema.encodeSync(
      Schema.fromJsonString(Schema.Array(AxisReviewFindingSchema)),
    );
    const filesJson = filesCodec([...new Set(input.filesCovered)].sort());
    const rulesJson = rulesCodec([...new Set(input.rulesUsed)].sort());
    const findingsJson = findingsCodec(
      [...input.findings].sort((a, b) => a.id.localeCompare(b.id)),
    );
    const createdAtDate = DateTime.nowUnsafe();
    const createdAt = DateTime.formatIso(createdAtDate);
    const insertedRows = yield* sql<ReviewRow>`
      INSERT INTO axis_review_evidence (
        context_id, scope_key, task_id, step_id, command_id,
        thread_id, turn_id, base_sha, head_sha, diff_digest,
        files_json, rules_json, findings_json, reviewer, note, created_at
      )
      VALUES (
        ${input.scope.contextId},
        ${projectScopeKeyFor(input.scope)},
        ${input.taskId},
        ${input.stepId},
        ${input.commandId},
        ${input.threadId},
        ${input.turnId},
        ${input.baseSha},
        ${input.headSha},
        ${input.diffDigest},
        ${filesJson},
        ${rulesJson},
        ${findingsJson},
        ${input.reviewer},
        ${input.note},
        ${createdAt}
      )
      ON CONFLICT(context_id, scope_key, task_id, step_id, command_id) DO NOTHING
      RETURNING
        context_id AS contextId,
        scope_key AS scopeKey,
        task_id AS taskId,
        step_id AS stepId,
        command_id AS commandId,
        thread_id AS threadId,
        turn_id AS turnId,
        base_sha AS baseSha,
        head_sha AS headSha,
        diff_digest AS diffDigest,
        files_json AS filesJson,
        rules_json AS rulesJson,
        findings_json AS findingsJson,
        reviewer,
        note,
        created_at AS createdAt
    `.pipe(
      Effect.mapError(() => error("persistence_failed", "Cannot persist review evidence row.")),
    );
    const written = insertedRows[0];
    if (written !== undefined) {
      const snapshot = yield* decodeRow(written);
      return { snapshot, alreadyRecorded: false };
    }
    const existing = yield* sql<ReviewRow>`
      SELECT
        context_id AS contextId,
        scope_key AS scopeKey,
        task_id AS taskId,
        step_id AS stepId,
        command_id AS commandId,
        thread_id AS threadId,
        turn_id AS turnId,
        base_sha AS baseSha,
        head_sha AS headSha,
        diff_digest AS diffDigest,
        files_json AS filesJson,
        rules_json AS rulesJson,
        findings_json AS findingsJson,
        reviewer,
        note,
        created_at AS createdAt
      FROM axis_review_evidence
      WHERE context_id = ${input.scope.contextId}
        AND scope_key = ${projectScopeKeyFor(input.scope)}
        AND task_id = ${input.taskId}
        AND step_id = ${input.stepId}
        AND command_id = ${input.commandId}
    `.pipe(
      Effect.mapError(() =>
        error("persistence_failed", "Cannot read existing review evidence row."),
      ),
    );
    const previous = existing[0];
    if (previous === undefined) {
      return yield* error(
        "persistence_failed",
        "Insert returned no row and the existing review is missing.",
      );
    }
    const previousEvidence = yield* decodeRow(previous);
    const previousFiles = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(Schema.String)),
    )(previous.filesJson as string).pipe(
      Effect.mapError(() => error("persistence_failed", "Cannot decode stored files.")),
    );
    const previousRules = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(Schema.String)),
    )(previous.rulesJson as string).pipe(
      Effect.mapError(() => error("persistence_failed", "Cannot decode stored rules.")),
    );
    const previousFindings = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(AxisReviewFindingSchema)),
    )(previous.findingsJson as string).pipe(
      Effect.mapError(() => error("persistence_failed", "Cannot decode stored findings.")),
    );
    const previousDigest = snapshotDigest({
      ...input,
      threadId: previous.threadId as ThreadId,
      turnId: previous.turnId as TurnId,
      baseSha: previous.baseSha as string,
      headSha: previous.headSha as string,
      diffDigest: previous.diffDigest as string,
      filesCovered: previousFiles,
      rulesUsed: previousRules,
      findings: previousFindings,
      reviewer: previous.reviewer as string,
      note: previous.note as string | null,
    });
    const candidateDigest = snapshotDigest(input);
    if (previousDigest !== candidateDigest) {
      return yield* error(
        "duplicate",
        "A different review evidence row already exists for this command and step.",
      );
    }
    const snapshot = yield* decodeRow(previous);
    return { snapshot, alreadyRecorded: true };
  });

export const revalidateAxisReviewEvidence = (
  input: AxisReviewRevalidate,
): Effect.Effect<AxisReviewSnapshot | null, AxisReviewEvidenceError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<ReviewRow>`
      SELECT
        context_id AS contextId,
        scope_key AS scopeKey,
        task_id AS taskId,
        step_id AS stepId,
        command_id AS commandId,
        thread_id AS threadId,
        turn_id AS turnId,
        base_sha AS baseSha,
        head_sha AS headSha,
        diff_digest AS diffDigest,
        files_json AS filesJson,
        rules_json AS rulesJson,
        findings_json AS findingsJson,
        reviewer,
        note,
        created_at AS createdAt
      FROM axis_review_evidence
      WHERE context_id = ${input.scope.contextId}
        AND scope_key = ${projectScopeKeyFor(input.scope)}
        AND task_id = ${input.taskId}
        AND step_id = ${input.stepId}
      ORDER BY datetime(created_at) DESC, command_id DESC
      LIMIT 1
    `.pipe(Effect.mapError(() => error("persistence_failed", "Cannot read review evidence row.")));
    const row = rows[0];
    if (row === undefined) return null;
    if (row.diffDigest !== input.currentDiffDigest) {
      return yield* error(
        "stale_review",
        "The recorded review diff digest does not match the current diff digest.",
      );
    }
    if (row.headSha !== input.currentHeadSha) {
      return yield* error(
        "head_changed",
        "The recorded review head SHA no longer matches the working tree head.",
      );
    }
    const snapshot = yield* decodeRow(row);
    return snapshot;
  });

export const diffDigestFor = (input: {
  readonly baseSha: string;
  readonly headSha: string;
  readonly diff: string;
}): string =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify({ base: input.baseSha, head: input.headSha, diff: input.diff }), "utf8")
    .digest("hex");

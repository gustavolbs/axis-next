/**
 * W08 — AxisReviewFeedback.
 *
 * Turns PR review comments into scoped learning evidence. Each comment
 * produces one evidence row keyed by (scope, sourceKind, sourceId, cursor),
 * so re-importing the same comment is idempotent. Rejection notes preserve
 * the per-task context (this is the only place that links evidence to the
 * run that produced the diff) and do not leak to other projects in the
 * same company.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import {
  AxisContextProjectScope,
  AxisLearningEvidenceId,
  CommandId,
  TrimmedNonEmptyString,
  axisProjectScopeKey,
} from "@t3tools/contracts";

const MAX_COMMENT_LENGTH = 8_000;
const MAX_FILE_LENGTH = 4_096;
const MAX_PROVENANCE = 2_000;
const projectScopeKeyFor = (scope: AxisContextProjectScope) => axisProjectScopeKey(scope.project);

export const AxisReviewFeedbackSourceKind = Schema.Literals([
  "thread-comment",
  "review-comment",
  "review-action",
]);
export type AxisReviewFeedbackSourceKind = typeof AxisReviewFeedbackSourceKind.Type;

export const AxisReviewFeedbackSeveritySchema = Schema.Literals([
  "comment",
  "suggestion",
  "blocker",
]);
export type AxisReviewFeedbackSeverity = typeof AxisReviewFeedbackSeveritySchema.Type;

export const AxisReviewFeedbackInputSchema = Schema.Struct({
  scope: AxisContextProjectScope,
  taskId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  threadId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  commandId: CommandId,
  source: Schema.Struct({
    kind: AxisReviewFeedbackSourceKind,
    sourceId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    cursor: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    url: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
  }),
  comment: Schema.Struct({
    author: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    body: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_COMMENT_LENGTH)),
    path: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_FILE_LENGTH))),
    line: Schema.NullOr(Schema.Int),
    severity: AxisReviewFeedbackSeveritySchema,
    createdAt: TrimmedNonEmptyString,
  }),
  resolution: Schema.Struct({
    outcome: Schema.Literals(["accepted", "rejected", "task-specific", "unresolved"]),
    note: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
    decidedBy: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    decidedAt: TrimmedNonEmptyString,
  }),
});
export type AxisReviewFeedbackInput = typeof AxisReviewFeedbackInputSchema.Type;

export const AxisReviewFeedbackResultSchema = Schema.Struct({
  evidenceId: AxisLearningEvidenceId,
  recordedAt: TrimmedNonEmptyString,
  alreadyRecorded: Schema.Boolean,
});
export type AxisReviewFeedbackResult = typeof AxisReviewFeedbackResultSchema.Type;

export class AxisReviewFeedbackError extends Schema.TaggedErrorClass<AxisReviewFeedbackError>()(
  "AxisReviewFeedbackError",
  {
    reason: Schema.Literals(["invalid_input", "scope_mismatch", "duplicate", "persistence_failed"]),
    message: Schema.String,
  },
) {}

type EvidenceRow = {
  readonly id: unknown;
  readonly createdAt: unknown;
};

const error = (reason: AxisReviewFeedbackError["reason"], message: string) =>
  new AxisReviewFeedbackError({ reason, message });

const summaryFor = (input: AxisReviewFeedbackInput): string => {
  const location =
    input.comment.path !== null
      ? input.comment.line !== null
        ? `${input.comment.path}:${input.comment.line}`
        : input.comment.path
      : "general";
  return [
    `PR feedback (${input.source.kind}) by ${input.comment.author} on ${location}`,
    `Severity: ${input.comment.severity}`,
    `Resolution: ${input.resolution.outcome}`,
  ].join(" | ");
};

const fingerprintFor = (input: AxisReviewFeedbackInput): string => {
  const payload = JSON.stringify({
    scope: projectScopeKeyFor(input.scope),
    sourceKind: input.source.kind,
    sourceId: input.source.sourceId,
    cursor: input.source.cursor,
  });
  return `sha256:${NodeCrypto.createHash("sha256").update(payload, "utf8").digest("hex")}`;
};

export const recordAxisReviewFeedback = (
  input: AxisReviewFeedbackInput,
): Effect.Effect<AxisReviewFeedbackResult, AxisReviewFeedbackError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const fingerprint = fingerprintFor(input);
    const summary = summaryFor(input);
    if (summary.length > MAX_PROVENANCE) {
      return yield* error(
        "invalid_input",
        "Feedback summary exceeds the maximum provenance length.",
      );
    }
    const sql = yield* SqlClient.SqlClient;
    const createdAt = DateTime.formatIso(DateTime.nowUnsafe());
    const rows = yield* sql<EvidenceRow>`
      INSERT INTO axis_review_feedback (
        id, context_id, scope_key, task_id, thread_id, command_id,
        source_kind, source_id, cursor, source_url,
        comment_author, comment_body, comment_path, comment_line, comment_severity, comment_created_at,
        resolution_outcome, resolution_note, resolution_decided_by, resolution_decided_at,
        fingerprint, summary, created_at
      )
      VALUES (
        ${input.scope.contextId} || ':' || ${fingerprint},
        ${input.scope.contextId},
        ${projectScopeKeyFor(input.scope)},
        ${input.taskId},
        ${input.threadId},
        ${input.commandId},
        ${input.source.kind},
        ${input.source.sourceId},
        ${input.source.cursor},
        ${input.source.url},
        ${input.comment.author},
        ${input.comment.body},
        ${input.comment.path},
        ${input.comment.line},
        ${input.comment.severity},
        ${input.comment.createdAt},
        ${input.resolution.outcome},
        ${input.resolution.note},
        ${input.resolution.decidedBy},
        ${input.resolution.decidedAt},
        ${fingerprint},
        ${summary},
        ${createdAt}
      )
      ON CONFLICT(context_id, scope_key, fingerprint) DO UPDATE
      SET
        task_id = excluded.task_id,
        thread_id = excluded.thread_id,
        command_id = excluded.command_id,
        comment_author = excluded.comment_author,
        comment_body = excluded.comment_body,
        comment_path = excluded.comment_path,
        comment_line = excluded.comment_line,
        comment_severity = excluded.comment_severity,
        comment_created_at = excluded.comment_created_at,
        resolution_outcome = excluded.resolution_outcome,
        resolution_note = excluded.resolution_note,
        resolution_decided_by = excluded.resolution_decided_by,
        resolution_decided_at = excluded.resolution_decided_at,
        summary = excluded.summary
      RETURNING id AS id, created_at AS createdAt
    `.pipe(
      Effect.mapError(() =>
        error("persistence_failed", "Cannot persist review feedback evidence row."),
      ),
    );
    const written = rows[0];
    if (written === undefined) {
      return yield* error(
        "persistence_failed",
        "Insert returned no row for the review feedback evidence.",
      );
    }
    return {
      evidenceId: written.id as string as AxisReviewFeedbackResult["evidenceId"],
      recordedAt: written.createdAt as string,
      alreadyRecorded: false,
    };
  });

export const feedbackFingerprintFor = (input: AxisReviewFeedbackInput): string =>
  fingerprintFor(input);

// @effect-diagnostics nodeBuiltinImport:off - feedback fingerprint ties PR comments to a stable evidence id.
import * as NodeCrypto from "node:crypto";
import {
  AxisContextId,
  AxisContextProjectScope,
  AxisLearningEvidence,
  AxisLearningEvidenceId,
  AxisLearningProvenance,
  AxisLearningScope,
  AxisProjectLocator,
  EnvironmentId,
  IsoDateTime,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { AxisProjectScope } from "../projects/AxisProjectScope.ts";

const ID_MAX = 128;
const URL_MAX = 2_048;
const AUTHOR_MAX = 256;
const PATH_MAX = 2_048;
const COMMENT_MAX = 8_000;
const FINGERPRINT_MAX = 128;
const DECISION_MAX = 64;

export const AxisReviewFeedbackSource = Schema.Literals([
  "pull-request-comment",
  "pull-request-review",
  "thread-reviewer-message",
]);
export type AxisReviewFeedbackSource = typeof AxisReviewFeedbackSource.Type;

export const AxisReviewFeedbackDecision = Schema.Literals([
  "accept",
  "defer",
  "reject",
  "specific-to-this-task",
]);
export type AxisReviewFeedbackDecision = typeof AxisReviewFeedbackDecision.Type;

const TrimmedDecision = Schema.Literals(["accept", "defer", "reject", "specific-to-this-task"]);

const TrimmedId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isMaxLength(ID_MAX),
);
const TrimmedUrl = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isMaxLength(URL_MAX),
);
const TrimmedAuthor = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isMaxLength(AUTHOR_MAX),
);
const TrimmedComment = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isMaxLength(COMMENT_MAX),
);
const TrimmedPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isMaxLength(PATH_MAX),
);
const TrimmedFingerprint = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isMaxLength(FINGERPRINT_MAX),
);

export const AxisReviewFeedbackComment = Schema.Struct({
  id: TrimmedId,
  author: TrimmedAuthor,
  url: Schema.NullOr(TrimmedUrl),
  body: TrimmedComment,
  path: Schema.NullOr(TrimmedPath),
  /** Line range within the file. Optional for general comments. */
  lineRange: Schema.NullOr(
    Schema.Struct({
      start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      end: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
  /** When the comment was authored on the upstream. */
  authoredAt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export type AxisReviewFeedbackComment = typeof AxisReviewFeedbackComment.Type;

export const AxisReviewFeedbackInput = Schema.Struct({
  /** Canonical project scope the PR belongs to. */
  scope: AxisContextProjectScope,
  /** External pull-request identifier (provider+repo+number). */
  pullRequestId: TrimmedId,
  pullRequestUrl: Schema.NullOr(TrimmedUrl),
  sourceKind: AxisReviewFeedbackSource,
  threadId: Schema.NullOr(TrimmedId),
  decision: TrimmedDecision,
  rationale: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  comments: Schema.Array(AxisReviewFeedbackComment).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  observedAt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export type AxisReviewFeedbackInput = typeof AxisReviewFeedbackInput.Type;

export const AxisReviewFeedbackErrorReason = Schema.Literals([
  "invalid_input",
  "scope_denied",
  "decision_invalid",
  "no_comments",
]);
export type AxisReviewFeedbackErrorReason = typeof AxisReviewFeedbackErrorReason.Type;

export class AxisReviewFeedbackError extends Schema.TaggedErrorClass<AxisReviewFeedbackError>()(
  "AxisReviewFeedbackError",
  { reason: AxisReviewFeedbackErrorReason, message: Schema.String },
) {}

export interface AxisReviewFeedbackResult {
  readonly evidence: ReadonlyArray<AxisLearningEvidence>;
  readonly fingerprint: string;
  readonly scope: AxisLearningScope;
}

export class AxisReviewFeedbackService extends Context.Service<
  AxisReviewFeedbackService,
  {
    readonly recordFeedback: (
      caller: { readonly environmentId: EnvironmentId; readonly contextId: AxisContextId },
      input: AxisReviewFeedbackInput,
    ) => Effect.Effect<AxisReviewFeedbackResult, AxisReviewFeedbackError>;
    readonly scopeFor: (scope: AxisContextProjectScope) => AxisLearningScope;
    readonly fingerprintFor: (
      pullRequestId: string,
      sourceKind: AxisReviewFeedbackSource,
      decision: AxisReviewFeedbackDecision,
      commentIds: ReadonlyArray<string>,
    ) => string;
  }
>()("t3/axis/tasks/AxisReviewFeedback/AxisReviewFeedbackService") {}

const decisionToRetention = (decision: AxisReviewFeedbackDecision): number => {
  switch (decision) {
    case "accept":
      return 90 * 24 * 60 * 60;
    case "defer":
      return 30 * 24 * 60 * 60;
    case "reject":
      return 365 * 24 * 60 * 60;
    case "specific-to-this-task":
      return 14 * 24 * 60 * 60;
  }
};

export const make = Effect.gen(function* () {
  const projectScope = yield* AxisProjectScope;
  const evidenceByFingerprint = new Map<
    string,
    { evidence: AxisLearningEvidence; scope: AxisLearningScope }
  >();

  const authorize = (
    caller: { readonly environmentId: EnvironmentId; readonly contextId: AxisContextId },
    target: AxisContextProjectScope,
    operation: "read" | "write",
  ) =>
    projectScope
      .resolveProject({
        caller: { environmentId: caller.environmentId, contextId: caller.contextId },
        scope: target,
        operation,
      })
      .pipe(
        Effect.mapError(
          () =>
            new AxisReviewFeedbackError({
              reason: "scope_denied",
              message: "Caller cannot record feedback for this project.",
            }),
        ),
      );

  const scopeFor: AxisReviewFeedbackService["Service"]["scopeFor"] = (target) => ({
    contextId: AxisContextId.make(target.contextId),
    project: Schema.decodeUnknownSync(AxisProjectLocator)(target.project),
  });

  const fingerprintFor: AxisReviewFeedbackService["Service"]["fingerprintFor"] = (
    pullRequestId,
    sourceKind,
    decision,
    commentIds,
  ) =>
    `sha256:${NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify({
          pullRequestId,
          sourceKind,
          decision,
          commentIds: [...commentIds].sort(),
        }),
        "utf8",
      )
      .digest("hex")}`;

  const recordFeedback: AxisReviewFeedbackService["Service"]["recordFeedback"] = (caller, raw) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(AxisReviewFeedbackInput)(raw).pipe(
        Effect.mapError(
          () =>
            new AxisReviewFeedbackError({
              reason: "invalid_input",
              message: "Review feedback input did not validate.",
            }),
        ),
      );
      yield* authorize(caller, input.scope, "write");
      if (input.comments.length === 0 && input.decision === "accept") {
        return yield* new AxisReviewFeedbackError({
          reason: "no_comments",
          message: "An accept decision requires at least one recorded comment.",
        });
      }
      const commentIds = input.comments.map((comment) => comment.id);
      const learningScope = scopeFor(input.scope);
      const fingerprint = fingerprintFor(
        input.pullRequestId,
        input.sourceKind,
        input.decision,
        commentIds,
      );
      const scopeFingerprint = fingerprintFor(
        `scope:${input.scope.contextId}:${input.scope.project.environmentId}:${input.scope.project.projectId}`,
        input.sourceKind,
        input.decision,
        commentIds,
      );
      const existing = evidenceByFingerprint.get(scopeFingerprint);
      if (existing !== undefined) {
        return {
          evidence: [existing.evidence],
          fingerprint,
          scope: existing.scope,
        } satisfies AxisReviewFeedbackResult;
      }
      const nowDateTime = yield* DateTime.now;
      const now = DateTime.formatIso(nowDateTime);
      const retentionSeconds = decisionToRetention(input.decision);
      const expiresAtIso = DateTime.formatIso(
        DateTime.add(nowDateTime, { seconds: retentionSeconds }),
      );
      const observedAt = yield* Schema.decodeEffect(IsoDateTime)(input.observedAt).pipe(
        Effect.mapError(
          () =>
            new AxisReviewFeedbackError({
              reason: "invalid_input",
              message: "Observed timestamp did not validate.",
            }),
        ),
      );
      const baseProvenance = yield* Schema.decodeUnknownEffect(AxisLearningProvenance)({
        contextId: input.scope.contextId,
        scope: learningScope,
        sourceKind: "user-correction",
        sourceId: `pr:${input.pullRequestId}`,
        observedAt,
        fingerprint,
        ...(input.threadId !== null ? { cursor: input.threadId } : {}),
      }).pipe(
        Effect.mapError(
          () =>
            new AxisReviewFeedbackError({
              reason: "invalid_input",
              message: "Learning provenance did not validate.",
            }),
        ),
      );
      const createdAtIso = yield* Schema.decodeEffect(IsoDateTime)(now).pipe(
        Effect.mapError(
          () =>
            new AxisReviewFeedbackError({
              reason: "invalid_input",
              message: "Command timestamp did not validate.",
            }),
        ),
      );
      const expiresAt = yield* Schema.decodeEffect(IsoDateTime)(expiresAtIso).pipe(
        Effect.mapError(
          () =>
            new AxisReviewFeedbackError({
              reason: "invalid_input",
              message: "Retention timestamp did not validate.",
            }),
        ),
      );
      const evidenceList: AxisLearningEvidence[] = [];
      for (const comment of input.comments) {
        const commentFingerprint = fingerprintFor(
          `${input.pullRequestId}:${comment.id}`,
          input.sourceKind,
          input.decision,
          commentIds,
        );
        const provenance = {
          ...baseProvenance,
          sourceId: `pr-comment:${input.pullRequestId}:${comment.id}`,
          fingerprint: commentFingerprint,
        };
        const evidence = yield* Schema.decodeUnknownEffect(AxisLearningEvidence)({
          id: AxisLearningEvidenceId.make(`pr-feedback-${input.pullRequestId}-${comment.id}`),
          provenance,
          summary: comment.body.slice(0, 2_000),
          createdAt: createdAtIso,
          expiresAt,
        }).pipe(
          Effect.mapError(
            () =>
              new AxisReviewFeedbackError({
                reason: "invalid_input",
                message: "Learning evidence did not validate.",
              }),
          ),
        );
        evidenceList.push(evidence);
      }
      if (input.comments.length === 0) {
        const evidence = yield* Schema.decodeUnknownEffect(AxisLearningEvidence)({
          id: AxisLearningEvidenceId.make(`pr-feedback-${input.pullRequestId}`),
          provenance: baseProvenance,
          summary: `PR ${input.pullRequestId} decision: ${input.decision}.`,
          createdAt: createdAtIso,
          expiresAt,
        }).pipe(
          Effect.mapError(
            () =>
              new AxisReviewFeedbackError({
                reason: "invalid_input",
                message: "Learning evidence did not validate.",
              }),
          ),
        );
        evidenceList.push(evidence);
      }
      const canonical = evidenceList[0] ?? null;
      if (canonical === null) {
        return yield* new AxisReviewFeedbackError({
          reason: "no_comments",
          message: "No feedback evidence was produced.",
        });
      }
      evidenceByFingerprint.set(scopeFingerprint, {
        evidence: canonical,
        scope: learningScope,
      });
      return {
        evidence: evidenceList,
        fingerprint,
        scope: learningScope,
      } satisfies AxisReviewFeedbackResult;
    });

  return {
    recordFeedback,
    scopeFor,
    fingerprintFor,
  } satisfies AxisReviewFeedbackService["Service"];
});

export const layer = Layer.effect(AxisReviewFeedbackService, make);

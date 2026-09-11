// @effect-diagnostics nodeBuiltinImport:off - diff digest binds review to the exact patch in scope.
import * as NodeCrypto from "node:crypto";
import {
  AxisContextProjectScope,
  AxisSkillId,
  AxisTaskStepId,
  CheckpointRef,
  CommandId,
  type OrchestrationCheckpointFile,
  ThreadId,
  TurnId,
  axisContextProjectScopeKey,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CheckpointDiffQuery } from "../../checkpointing/CheckpointDiffQuery.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AxisProjectScope } from "../projects/AxisProjectScope.ts";

const SUMMARY_MAX = 2_000;
const REASON_MAX = 2_000;
const FINDING_TEXT_MAX = 4_000;
const FILE_PATH_MAX = 2_048;
const COMMENT_AUTHOR_MAX = 256;
const HEAD_OID_MAX = 64;
const REF_MAX = 256;

export const AxisReviewFindingSeverity = Schema.Literals(["blocker", "suggestion", "nit"]);
export type AxisReviewFindingSeverity = typeof AxisReviewFindingSeverity.Type;

export const AxisReviewVerdict = Schema.Literals(["approve", "request-changes", "comment"]);
export type AxisReviewVerdict = typeof AxisReviewVerdict.Type;

const TrimmedSummary = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isMaxLength(SUMMARY_MAX),
);

const TrimmedReason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isMaxLength(REASON_MAX),
);

const TrimmedPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isMaxLength(FILE_PATH_MAX),
);

const OptionalRef = Schema.NullOr(
  Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(REF_MAX)),
);

export const AxisReviewFinding = Schema.Struct({
  severity: AxisReviewFindingSeverity,
  /** Either a code line range, a path, or both. Free text is intentionally rejected. */
  path: TrimmedPath,
  lineRange: Schema.NullOr(
    Schema.Struct({
      start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      end: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
  summary: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isTrimmed(),
    Schema.isMaxLength(FINDING_TEXT_MAX),
  ),
  rationale: Schema.optionalKey(TrimmedSummary),
});
export type AxisReviewFinding = typeof AxisReviewFinding.Type;

export const AxisReviewEvidence = Schema.Struct({
  scope: AxisContextProjectScope,
  stepId: AxisTaskStepId,
  skillId: AxisSkillId,
  turnId: TurnId,
  commandId: CommandId,
  /** Stable digest over the entire captured patch. Review conclusions are
   *  considered invalid when this digest diverges from a freshly captured one. */
  diffDigest: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  fromTurnCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  toTurnCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  fromCheckpointRef: OptionalRef,
  toCheckpointRef: OptionalRef,
  headOid: OptionalRef,
  baseRefName: OptionalRef,
  headRefName: OptionalRef,
  files: Schema.Array(
    Schema.Struct({
      path: TrimmedPath,
      insertions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      deletions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      kind: Schema.Literals(["added", "modified", "deleted", "renamed", "binary"]),
    }),
  ),
  findings: Schema.Array(AxisReviewFinding).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  verdict: AxisReviewVerdict,
  summary: TrimmedSummary,
  reason: Schema.NullOr(TrimmedReason),
  ruleSourcesUsed: Schema.Array(TrimmedPath).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  capturedAt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export type AxisReviewEvidence = typeof AxisReviewEvidence.Type;

export const AxisReviewEvidenceErrorReason = Schema.Literals([
  "invalid_input",
  "scope_denied",
  "observation_failed",
  "no_checkpoint",
  "stale",
]);
export type AxisReviewEvidenceErrorReason = typeof AxisReviewEvidenceErrorReason.Type;

export class AxisReviewEvidenceError extends Schema.TaggedErrorClass<AxisReviewEvidenceError>()(
  "AxisReviewEvidenceError",
  { reason: AxisReviewEvidenceErrorReason, message: Schema.String },
) {}

export interface AxisReviewEvidenceRequest {
  readonly scope: AxisContextProjectScope;
  readonly stepId: AxisTaskStepId;
  readonly skillId: AxisSkillId;
  readonly turnId: TurnId;
  readonly commandId: CommandId;
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
  readonly verdict: AxisReviewVerdict;
  readonly summary: string;
  readonly reason?: string | null;
  readonly findings?: ReadonlyArray<AxisReviewFinding["Type"]>;
  readonly ruleSourcesUsed?: ReadonlyArray<string>;
}

export interface AxisReviewEvidenceService {
  readonly capture: (
    caller: { readonly environmentId: string; readonly contextId: string },
    request: AxisReviewEvidenceRequest,
  ) => Effect.Effect<AxisReviewEvidence, AxisReviewEvidenceError>;
  readonly verifyCurrentDigest: (
    caller: { readonly environmentId: string; readonly contextId: string },
    evidence: AxisReviewEvidence,
  ) => Effect.Effect<boolean, AxisReviewEvidenceError>;
  readonly listForScope: (
    caller: { readonly environmentId: string; readonly contextId: string },
    scope: AxisContextProjectScope,
  ) => Effect.Effect<ReadonlyArray<AxisReviewEvidence>, AxisReviewEvidenceError>;
}

export class AxisReviewEvidenceService extends Context.Service<AxisReviewEvidenceService>()(
  "t3/axis/tasks/AxisReviewEvidence",
) {}

const digestFor = (input: {
  readonly fromCheckpointRef: CheckpointRef | null;
  readonly toCheckpointRef: CheckpointRef | null;
  readonly headOid: string | null;
  readonly baseRefName: string | null;
  readonly headRefName: string | null;
  readonly files: ReadonlyArray<OrchestrationCheckpointFile>;
  readonly diff: string;
}) =>
  `sha256:${NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        from: input.fromCheckpointRef,
        to: input.toCheckpointRef,
        headOid: input.headOid,
        baseRefName: input.baseRefName,
        headRefName: input.headRefName,
        files: input.files.map((file) => [file.path, file.kind, file.insertions, file.deletions]),
        diff: input.diff,
      }),
      "utf8",
    )
    .digest("hex")}`;

const reviewKey = (scope: AxisContextProjectScope, commandId: CommandId, turnId: TurnId) =>
  `${axisContextProjectScopeKey(scope)}|${commandId}|${turnId}`;

export const make = Effect.gen(function* () {
  const diff = yield* CheckpointDiffQuery;
  const snapshots = yield* ProjectionSnapshotQuery;
  const projectScope = yield* AxisProjectScope;
  const reviews = new Map<string, AxisReviewEvidence>();

  const authorize = (
    caller: { readonly environmentId: string; readonly contextId: string },
    scope: AxisContextProjectScope,
    operation: "read" | "write",
  ) =>
    projectScope
      .resolveProject({
        caller: { environmentId: caller.environmentId, contextId: caller.contextId },
        scope,
        operation,
      })
      .pipe(
        Effect.mapError(
          () =>
            new AxisReviewEvidenceError({
              reason: "scope_denied",
              message: "Caller cannot capture or read review evidence for this project.",
            }),
        ),
      );

  const resolveContext = (commandId: CommandId, toTurnCount: number) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(`axis-workflow-review:${commandId}`);
      const context = yield* snapshots.getFullThreadDiffContext(threadId, toTurnCount).pipe(
        Effect.mapError(
          () =>
            new AxisReviewEvidenceError({
              reason: "observation_failed",
              message: "Thread snapshot is not available for diff context.",
            }),
        ),
      );
      if (Option.isNone(context)) return Option.none();
      const ctxValue = context.value;
      return Option.some({
        threadId,
        baseRefName: null as string | null,
        headRefName: null as string | null,
        headOid: ctxValue.toCheckpointRef,
        fromCheckpointRef: `refs/t3/checkpoints/${threadId}/turn-0` as CheckpointRef,
        toCheckpointRef: ctxValue.toCheckpointRef,
        workspaceRoot: ctxValue.workspaceRoot,
        worktreePath: ctxValue.worktreePath,
      });
    });

  const capture: AxisReviewEvidenceService["capture"] = (caller, raw) =>
    Effect.gen(function* () {
      const request = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          scope: AxisContextProjectScope,
          stepId: AxisTaskStepId,
          skillId: AxisSkillId,
          turnId: TurnId,
          commandId: CommandId,
          fromTurnCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          toTurnCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          verdict: AxisReviewVerdict,
          summary: TrimmedSummary,
          reason: Schema.optionalKey(Schema.NullOr(TrimmedReason)),
          findings: Schema.optionalKey(
            Schema.Array(AxisReviewFinding).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
          ),
          ruleSourcesUsed: Schema.optionalKey(
            Schema.Array(TrimmedPath).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
          ),
        }),
      )(raw).pipe(
        Effect.mapError(
          () =>
            new AxisReviewEvidenceError({
              reason: "invalid_input",
              message: "Review request did not validate.",
            }),
        ),
      );
      if (request.fromTurnCount > request.toTurnCount) {
        return yield* new AxisReviewEvidenceError({
          reason: "invalid_input",
          message: "fromTurnCount must be less than or equal to toTurnCount.",
        });
      }
      yield* authorize(caller, request.scope, "write");
      const maybeContext = yield* resolveContext(request.commandId, request.toTurnCount);
      let diffResult: { diff: string; files: ReadonlyArray<OrchestrationCheckpointFile> } = {
        diff: "",
        files: [],
      };
      let resolvedContext: {
        threadId: ThreadId;
        fromCheckpointRef: CheckpointRef;
        toCheckpointRef: CheckpointRef | null;
        headOid: CheckpointRef | null;
        baseRefName: string | null;
        headRefName: string | null;
      } | null = null;
      if (Option.isSome(maybeContext)) {
        const ctx = maybeContext.value;
        resolvedContext = ctx;
        const got = yield* diff
          .getTurnDiff({
            threadId: ctx.threadId,
            fromTurnCount: request.fromTurnCount,
            toTurnCount: request.toTurnCount,
            ignoreWhitespace: false,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new AxisReviewEvidenceError({
                  reason: "no_checkpoint",
                  message: `Cannot read the turn diff for review: ${(cause as { message?: string }).message ?? (cause as { _tag?: string })._tag ?? "unknown"}.`,
                }),
            ),
          );
        diffResult = { diff: got.diff, files: [] };
      } else if (request.verdict !== "comment") {
        return yield* new AxisReviewEvidenceError({
          reason: "no_checkpoint",
          message:
            "A non-comment review requires a captured diff. Capture evidence after the checkpoint reaches 'ready' state.",
        });
      }
      const capturedAt = DateTime.formatIso(yield* DateTime.now);
      const evidence = Schema.decodeUnknownSync(AxisReviewEvidence)({
        scope: request.scope,
        stepId: request.stepId,
        skillId: request.skillId,
        turnId: request.turnId,
        commandId: request.commandId,
        diffDigest: digestFor({
          fromCheckpointRef: resolvedContext?.fromCheckpointRef ?? null,
          toCheckpointRef: resolvedContext?.toCheckpointRef ?? null,
          headOid: resolvedContext?.headOid ?? null,
          baseRefName: resolvedContext?.baseRefName ?? null,
          headRefName: resolvedContext?.headRefName ?? null,
          files: diffResult.files,
          diff: diffResult.diff,
        }),
        fromTurnCount: request.fromTurnCount,
        toTurnCount: request.toTurnCount,
        fromCheckpointRef: resolvedContext?.fromCheckpointRef ?? null,
        toCheckpointRef: resolvedContext?.toCheckpointRef ?? null,
        headOid: resolvedContext?.headOid ?? null,
        baseRefName: resolvedContext?.baseRefName ?? null,
        headRefName: resolvedContext?.headRefName ?? null,
        files: diffResult.files.map((file) => ({
          path: file.path,
          insertions: file.insertions,
          deletions: file.deletions,
          kind: file.kind,
        })),
        findings: request.findings ?? [],
        verdict: request.verdict,
        summary: request.summary,
        reason: request.reason ?? null,
        ruleSourcesUsed: request.ruleSourcesUsed ?? [],
        capturedAt,
      });
      reviews.set(reviewKey(request.scope, request.commandId, request.turnId), evidence);
      return evidence;
    });

  const verifyCurrentDigest: AxisReviewEvidenceService["verifyCurrentDigest"] = (
    caller,
    evidence,
  ) =>
    Effect.gen(function* () {
      yield* authorize(caller, evidence.scope, "read");
      const threadId = ThreadId.make(`axis-workflow-review:${evidence.commandId}`);
      const got = yield* diff
        .getTurnDiff({
          threadId,
          fromTurnCount: evidence.fromTurnCount,
          toTurnCount: evidence.toTurnCount,
          ignoreWhitespace: false,
        })
        .pipe(
          Effect.mapError(
            () =>
              new AxisReviewEvidenceError({
                reason: "observation_failed",
                message: "Cannot re-read the diff to verify the review digest.",
              }),
          ),
        );
      const context = yield* snapshots
        .getFullThreadDiffContext(threadId, evidence.toTurnCount)
        .pipe(
          Effect.mapError(
            () =>
              new AxisReviewEvidenceError({
                reason: "observation_failed",
                message: "Cannot read the diff context to verify the review digest.",
              }),
          ),
        );
      if (Option.isNone(context)) {
        return yield* new AxisReviewEvidenceError({
          reason: "observation_failed",
          message: "Diff context disappeared between capture and verification.",
        });
      }
      const current = digestFor({
        fromCheckpointRef: evidence.fromCheckpointRef,
        toCheckpointRef: context.value.toCheckpointRef,
        headOid: evidence.headOid,
        baseRefName: evidence.baseRefName,
        headRefName: evidence.headRefName,
        files: [],
        diff: got.diff,
      });
      return current === evidence.diffDigest;
    });

  const listForScope: AxisReviewEvidenceService["listForScope"] = (caller, scope) =>
    Effect.gen(function* () {
      yield* authorize(caller, scope, "read");
      return [...reviews.values()].filter(
        (evidence) =>
          evidence.scope.contextId === scope.contextId &&
          evidence.scope.project.environmentId === scope.project.environmentId &&
          evidence.scope.project.projectId === scope.project.projectId,
      );
    });

  return { capture, verifyCurrentDigest, listForScope } satisfies AxisReviewEvidenceService;
});

export const layer = Layer.effect(AxisReviewEvidenceService, make);

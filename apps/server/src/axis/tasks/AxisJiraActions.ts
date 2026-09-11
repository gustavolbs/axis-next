/**
 * X06 — AxisJiraActions.
 *
 * Wraps Jira comment/transition actions in an idempotent adapter. The
 * adapter persists an intent (source key + idempotency key) so a lost
 * response can be reconciled by listing comments/transitions on the issue
 * rather than replaying the write.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import {
  AxisContextProjectScope,
  CommandId,
  TrimmedNonEmptyString,
  axisProjectScopeKey,
} from "@t3tools/contracts";

const MAX_BODY_LENGTH = 32_000;
const MAX_REASON_LENGTH = 256;
const MAX_TRANSITION_LENGTH = 64;
const projectScopeKeyFor = (scope: AxisContextProjectScope) => axisProjectScopeKey(scope.project);

export const AxisJiraActionKindSchema = Schema.Literals(["comment", "transition", "link-pr"]);
export type AxisJiraActionKind = typeof AxisJiraActionKindSchema.Type;

export const AxisJiraActionInputSchema = Schema.Struct({
  scope: AxisContextProjectScope,
  issueKey: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  commandId: CommandId,
  kind: AxisJiraActionKindSchema,
  body: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_BODY_LENGTH))),
  transition: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_TRANSITION_LENGTH))),
  reason: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_REASON_LENGTH))),
  pullRequestUrl: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
});
export type AxisJiraActionInput = typeof AxisJiraActionInputSchema.Type;

export const AxisJiraActionResultSchema = Schema.Struct({
  scope: AxisContextProjectScope,
  issueKey: Schema.String,
  commandId: CommandId,
  kind: AxisJiraActionKindSchema,
  intentId: Schema.String,
  status: Schema.Literals(["pending", "applied", "reconciled", "revoked"]),
  appliedAt: Schema.NullOr(Schema.String),
  remoteId: Schema.NullOr(Schema.String),
});
export type AxisJiraActionResult = typeof AxisJiraActionResultSchema.Type;

export class AxisJiraActionsError extends Schema.TaggedErrorClass<AxisJiraActionsError>()(
  "AxisJiraActionsError",
  {
    reason: Schema.Literals([
      "invalid_input",
      "scope_mismatch",
      "missing_field",
      "auth_revoked",
      "conflict",
      "persistence_failed",
    ]),
    message: Schema.String,
  },
) {}

type IntentRow = {
  readonly id: unknown;
  readonly kind: unknown;
  readonly status: unknown;
  readonly appliedAt: unknown;
  readonly remoteId: unknown;
};

export interface AxisJiraRemoteAdapter {
  readonly comment: (input: {
    readonly issueKey: string;
    readonly body: string;
    readonly reason: string | null;
  }) => Effect.Effect<
    { readonly remoteId: string },
    { readonly _tag: string; readonly message: string }
  >;
  readonly transition: (input: {
    readonly issueKey: string;
    readonly transition: string;
    readonly reason: string | null;
  }) => Effect.Effect<
    { readonly remoteId: string },
    { readonly _tag: string; readonly message: string }
  >;
  readonly listComments: (input: {
    readonly issueKey: string;
  }) => Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly body: string; readonly createdAt: string }>,
    { readonly _tag: string; readonly message: string }
  >;
  readonly listTransitions: (input: {
    readonly issueKey: string;
  }) => Effect.Effect<
    ReadonlyArray<{ readonly transition: string; readonly occurredAt: string }>,
    { readonly _tag: string; readonly message: string }
  >;
}

const error = (reason: AxisJiraActionsError["reason"], message: string) =>
  new AxisJiraActionsError({ reason, message });

const intentIdFor = (input: AxisJiraActionInput): string => {
  const payload = JSON.stringify({
    scope: projectScopeKeyFor(input.scope),
    issueKey: input.issueKey,
    commandId: input.commandId,
    kind: input.kind,
    body: input.body,
    transition: input.transition,
    pullRequestUrl: input.pullRequestUrl,
  });
  return `axis-jira-${NodeCrypto.createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 24)}`;
};

export const applyAxisJiraAction = (
  adapter: AxisJiraRemoteAdapter,
  input: AxisJiraActionInput,
): Effect.Effect<AxisJiraActionResult, AxisJiraActionsError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    if (input.kind === "comment" && input.body === null) {
      return yield* error("missing_field", "A comment action requires a body.");
    }
    if (input.kind === "transition" && input.transition === null) {
      return yield* error("missing_field", "A transition action requires a transition name.");
    }
    if (input.kind === "link-pr" && input.pullRequestUrl === null) {
      return yield* error("missing_field", "A link-pr action requires a pull request URL.");
    }
    const sql = yield* SqlClient.SqlClient;
    const intentId = intentIdFor(input);
    const existing = yield* sql<IntentRow>`
      SELECT
        id AS id,
        kind AS kind,
        status AS status,
        applied_at AS appliedAt,
        remote_id AS remoteId
      FROM axis_jira_action_intents
      WHERE context_id = ${input.scope.contextId}
        AND scope_key = ${projectScopeKeyFor(input.scope)}
        AND issue_key = ${input.issueKey}
        AND command_id = ${input.commandId}
    `.pipe(Effect.mapError(() => error("persistence_failed", "Cannot read existing jira intent.")));
    const existingRow = existing[0];
    if (existingRow !== undefined) {
      return {
        scope: input.scope,
        issueKey: input.issueKey,
        commandId: input.commandId,
        kind: existingRow.kind as AxisJiraActionKind,
        intentId: existingRow.id as string,
        status: existingRow.status as AxisJiraActionResult["status"],
        appliedAt: existingRow.appliedAt as string | null,
        remoteId: existingRow.remoteId as string | null,
      };
    }
    const createdAt = DateTime.formatIso(DateTime.nowUnsafe());
    yield* sql`
      INSERT INTO axis_jira_action_intents (
        id, context_id, scope_key, issue_key, command_id,
        kind, status, applied_at, remote_id, created_at
      )
      VALUES (
        ${intentId},
        ${input.scope.contextId},
        ${projectScopeKeyFor(input.scope)},
        ${input.issueKey},
        ${input.commandId},
        ${input.kind},
        'pending',
        NULL,
        NULL,
        ${createdAt}
      )
    `.pipe(Effect.mapError(() => error("persistence_failed", "Cannot persist jira intent.")));
    const apply =
      input.kind === "comment"
        ? adapter.comment({
            issueKey: input.issueKey,
            body: input.body ?? "",
            reason: input.reason,
          })
        : input.kind === "transition"
          ? adapter.transition({
              issueKey: input.issueKey,
              transition: input.transition ?? "",
              reason: input.reason,
            })
          : adapter.comment({
              issueKey: input.issueKey,
              body: `Linked PR: ${input.pullRequestUrl ?? ""}`,
              reason: input.reason,
            });
    const remote = yield* apply.pipe(
      Effect.mapError((cause) => {
        if (cause._tag === "AuthRevokedError" || cause._tag === "AuthScopeError") {
          return error("auth_revoked", cause.message);
        }
        return error("conflict", cause.message);
      }),
    );
    const reconciled =
      input.kind === "comment" || input.kind === "link-pr"
        ? yield* adapter.listComments({ issueKey: input.issueKey }).pipe(
            Effect.map((comments) =>
              comments.some(
                (comment) =>
                  comment.body === (input.body ?? `Linked PR: ${input.pullRequestUrl ?? ""}`),
              ),
            ),
            Effect.mapError((cause) =>
              error("persistence_failed", `Cannot reconcile jira comments: ${cause.message}`),
            ),
          )
        : yield* adapter.listTransitions({ issueKey: input.issueKey }).pipe(
            Effect.map((transitions) =>
              transitions.some((transition) => transition.transition === input.transition),
            ),
            Effect.mapError((cause) =>
              error("persistence_failed", `Cannot reconcile jira transitions: ${cause.message}`),
            ),
          );
    const finalStatus = reconciled ? "applied" : "pending";
    yield* sql`
      UPDATE axis_jira_action_intents
      SET
        status = ${finalStatus},
        applied_at = ${reconciled ? createdAt : null},
        remote_id = ${remote.remoteId}
      WHERE context_id = ${input.scope.contextId}
        AND scope_key = ${projectScopeKeyFor(input.scope)}
        AND issue_key = ${input.issueKey}
        AND command_id = ${input.commandId}
    `.pipe(Effect.mapError(() => error("persistence_failed", "Cannot update jira intent status.")));
    return {
      scope: input.scope,
      issueKey: input.issueKey,
      commandId: input.commandId,
      kind: input.kind,
      intentId,
      status: finalStatus,
      appliedAt: reconciled ? createdAt : null,
      remoteId: remote.remoteId,
    };
  });

export const jiraIntentIdFor = (input: AxisJiraActionInput): string => intentIdFor(input);

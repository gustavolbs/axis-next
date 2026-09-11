/**
 * X07 — AxisTrelloActions.
 *
 * Mirror of AxisJiraActions for Trello. Persists a card-bound intent so a
 * retry collapses on the same commandId, and reconciles by listing the
 * card's actions rather than replaying the write.
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

const MAX_BODY_LENGTH = 16_384;
const MAX_LIST_LENGTH = 256;
const projectScopeKeyFor = (scope: AxisContextProjectScope) => axisProjectScopeKey(scope.project);

export const AxisTrelloActionKindSchema = Schema.Literals(["comment", "move"]);
export type AxisTrelloActionKind = typeof AxisTrelloActionKindSchema.Type;

export const AxisTrelloActionInputSchema = Schema.Struct({
  scope: AxisContextProjectScope,
  cardId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  commandId: CommandId,
  kind: AxisTrelloActionKindSchema,
  body: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_BODY_LENGTH))),
  targetList: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_LIST_LENGTH))),
  reason: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type AxisTrelloActionInput = typeof AxisTrelloActionInputSchema.Type;

export const AxisTrelloActionResultSchema = Schema.Struct({
  scope: AxisContextProjectScope,
  cardId: Schema.String,
  commandId: CommandId,
  kind: AxisTrelloActionKindSchema,
  intentId: Schema.String,
  status: Schema.Literals(["pending", "applied", "reconciled", "revoked"]),
  appliedAt: Schema.NullOr(Schema.String),
  remoteId: Schema.NullOr(Schema.String),
  currentList: Schema.NullOr(Schema.String),
});
export type AxisTrelloActionResult = typeof AxisTrelloActionResultSchema.Type;

export class AxisTrelloActionsError extends Schema.TaggedErrorClass<AxisTrelloActionsError>()(
  "AxisTrelloActionsError",
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

export interface AxisTrelloRemoteAdapter {
  readonly comment: (input: {
    readonly cardId: string;
    readonly body: string;
    readonly reason: string | null;
  }) => Effect.Effect<
    { readonly remoteId: string },
    { readonly _tag: string; readonly message: string }
  >;
  readonly move: (input: {
    readonly cardId: string;
    readonly targetList: string;
    readonly reason: string | null;
  }) => Effect.Effect<
    { readonly remoteId: string; readonly currentList: string },
    { readonly _tag: string; readonly message: string }
  >;
  readonly listComments: (input: {
    readonly cardId: string;
  }) => Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly body: string; readonly createdAt: string }>,
    { readonly _tag: string; readonly message: string }
  >;
  readonly getCard: (input: {
    readonly cardId: string;
  }) => Effect.Effect<
    { readonly idList: string; readonly name: string },
    { readonly _tag: string; readonly message: string }
  >;
}

const error = (reason: AxisTrelloActionsError["reason"], message: string) =>
  new AxisTrelloActionsError({ reason, message });

const intentIdFor = (input: AxisTrelloActionInput): string => {
  const payload = JSON.stringify({
    scope: projectScopeKeyFor(input.scope),
    cardId: input.cardId,
    commandId: input.commandId,
    kind: input.kind,
    body: input.body,
    targetList: input.targetList,
  });
  return `axis-trello-${NodeCrypto.createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 24)}`;
};

export const applyAxisTrelloAction = (
  adapter: AxisTrelloRemoteAdapter,
  input: AxisTrelloActionInput,
): Effect.Effect<AxisTrelloActionResult, AxisTrelloActionsError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    if (input.kind === "comment" && input.body === null) {
      return yield* error("missing_field", "A comment action requires a body.");
    }
    if (input.kind === "move" && input.targetList === null) {
      return yield* error("missing_field", "A move action requires a target list.");
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
      FROM axis_trello_action_intents
      WHERE context_id = ${input.scope.contextId}
        AND scope_key = ${projectScopeKeyFor(input.scope)}
        AND card_id = ${input.cardId}
        AND command_id = ${input.commandId}
    `.pipe(
      Effect.mapError(() => error("persistence_failed", "Cannot read existing trello intent.")),
    );
    const existingRow = existing[0];
    if (existingRow !== undefined) {
      return {
        scope: input.scope,
        cardId: input.cardId,
        commandId: input.commandId,
        kind: existingRow.kind as AxisTrelloActionKind,
        intentId: existingRow.id as string,
        status: existingRow.status as AxisTrelloActionResult["status"],
        appliedAt: existingRow.appliedAt as string | null,
        remoteId: existingRow.remoteId as string | null,
        currentList: null,
      };
    }
    const createdAt = DateTime.formatIso(DateTime.nowUnsafe());
    yield* sql`
      INSERT INTO axis_trello_action_intents (
        id, context_id, scope_key, card_id, command_id,
        kind, status, applied_at, remote_id, created_at
      )
      VALUES (
        ${intentId},
        ${input.scope.contextId},
        ${projectScopeKeyFor(input.scope)},
        ${input.cardId},
        ${input.commandId},
        ${input.kind},
        'pending',
        NULL,
        NULL,
        ${createdAt}
      )
    `.pipe(Effect.mapError(() => error("persistence_failed", "Cannot persist trello intent.")));
    const apply =
      input.kind === "comment"
        ? adapter.comment({
            cardId: input.cardId,
            body: input.body ?? "",
            reason: input.reason,
          })
        : adapter.move({
            cardId: input.cardId,
            targetList: input.targetList ?? "",
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
      input.kind === "comment"
        ? yield* adapter.listComments({ cardId: input.cardId }).pipe(
            Effect.map((comments) =>
              comments.some((comment) => comment.body === (input.body ?? "")),
            ),
            Effect.mapError((cause) =>
              error("persistence_failed", `Cannot reconcile trello comments: ${cause.message}`),
            ),
          )
        : yield* adapter.getCard({ cardId: input.cardId }).pipe(
            Effect.map((card) => card.idList === input.targetList),
            Effect.mapError((cause) =>
              error("persistence_failed", `Cannot read trello card: ${cause.message}`),
            ),
          );
    const finalStatus = reconciled ? "applied" : "pending";
    yield* sql`
      UPDATE axis_trello_action_intents
      SET
        status = ${finalStatus},
        applied_at = ${reconciled ? createdAt : null},
        remote_id = ${remote.remoteId}
      WHERE context_id = ${input.scope.contextId}
        AND scope_key = ${projectScopeKeyFor(input.scope)}
        AND card_id = ${input.cardId}
        AND command_id = ${input.commandId}
    `.pipe(
      Effect.mapError(() => error("persistence_failed", "Cannot update trello intent status.")),
    );
    return {
      scope: input.scope,
      cardId: input.cardId,
      commandId: input.commandId,
      kind: input.kind,
      intentId,
      status: finalStatus,
      appliedAt: reconciled ? createdAt : null,
      remoteId: remote.remoteId,
      currentList: input.kind === "move" && "currentList" in remote ? remote.currentList : null,
    };
  });

export const trelloIntentIdFor = (input: AxisTrelloActionInput): string => intentIdFor(input);

/**
 * AxisTrelloActions - Authoritative Trello write coordinator for Axis workflows.
 *
 * Sits between the workflow layer (W07/W09) and the AxisTrelloWriteAdapter
 * transport contract (testable). The actions module owns:
 *
 *  - Idempotency via source-keyed `intentId` (commandId + Trello cardId).
 *  - Native board/list identity preservation: when a move is requested with
 *    a list id, the resulting confirmed snapshot stores the list id exactly
 *    as returned by the adapter, never substituting it with an Axis-inferred
 *    column label.
 *  - Last confirmed snapshot stays untouched when a write fails so callers
 *    can decide whether to retry, escalate or request fresh confirmation.
 *
 * No Trello network access is performed here. The implementation defers to
 * `AxisTrelloWriteAdapter`, which is the only layer that talks to a real
 * Trello transport; the smoke environment uses
 * `makeAxisTrelloWriteAdapterNoop`.
 */
import { CommandId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  type AxisTrelloBindingIdentity,
  AxisTrelloCardAction,
  type AxisTrelloCommentInput,
  type AxisTrelloMoveCardInput,
  type AxisTrelloWriteAdapter,
  type AxisTrelloError,
  AxisTrelloWriteAdapterService,
} from "./AxisTrelloWriteAdapter.ts";

const trelloIntentId = (commandId: CommandId, cardId: string): string =>
  `trello-intent:${commandId}:${cardId}`;

const trelloIntentKeyRegex = /^trello-intent:[A-Za-z0-9][A-Za-z0-9_-]*:[A-Za-z0-9_-]+$/u;

export const AxisTrelloIntentId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(trelloIntentKeyRegex),
).pipe(Schema.brand("AxisTrelloIntentId"));
export type AxisTrelloIntentId = typeof AxisTrelloIntentId.Type;

export const AxisTrelloIntentRecord = Schema.Struct({
  intentId: AxisTrelloIntentId,
  commandId: CommandId,
  cardId: Schema.String,
  action: AxisTrelloCardAction,
  bodyDigest: Schema.String,
  createdAt: Schema.String,
  status: Schema.Literals(["pending", "confirmed", "stale", "failed"]),
});
export type AxisTrelloIntentRecord = typeof AxisTrelloIntentRecord.Type;

export const AxisTrelloConfirmedSnapshot = Schema.Struct({
  cardId: Schema.String,
  lastConfirmedAt: Schema.String,
  lastIntentId: AxisTrelloIntentId,
  lastAction: AxisTrelloCardAction,
  listId: Schema.optional(Schema.String),
  commentId: Schema.optional(Schema.String),
});
export type AxisTrelloConfirmedSnapshot = typeof AxisTrelloConfirmedSnapshot.Type;

export class AxisTrelloIntentRevokedError extends Schema.TaggedErrorClass<{
  readonly _tag: "AxisTrelloIntentRevokedError";
  readonly message: string;
}>()("AxisTrelloIntentRevokedError", { message: Schema.String }) {}

export class AxisTrelloIntentStaleError extends Schema.TaggedErrorClass<{
  readonly _tag: "AxisTrelloIntentStaleError";
  readonly message: string;
}>()("AxisTrelloIntentStaleError", { message: Schema.String }) {}

export interface TrelloActionResult {
  readonly intentId: AxisTrelloIntentId;
  readonly snapshot: AxisTrelloConfirmedSnapshot;
  readonly alreadyConfirmed: boolean;
}

export interface PostTrelloCommentInput {
  readonly binding: AxisTrelloBindingIdentity;
  readonly sourceCardId: string;
  readonly body: string;
  readonly commandId: CommandId;
}

export interface MoveTrelloCardInput {
  readonly binding: AxisTrelloBindingIdentity;
  readonly sourceCardId: string;
  readonly listId: string;
  readonly commandId: CommandId;
}

export interface AxisTrelloActionsShape {
  readonly postComment: (
    input: PostTrelloCommentInput,
  ) => Effect.Effect<
    TrelloActionResult,
    AxisTrelloError | AxisTrelloIntentRevokedError | AxisTrelloIntentStaleError
  >;
  readonly moveCard: (
    input: MoveTrelloCardInput,
  ) => Effect.Effect<
    TrelloActionResult,
    AxisTrelloError | AxisTrelloIntentRevokedError | AxisTrelloIntentStaleError
  >;
  readonly getSnapshot: (
    binding: AxisTrelloBindingIdentity,
    cardId: string,
  ) => Effect.Effect<Option.Option<AxisTrelloConfirmedSnapshot>>;
  readonly revoke: (binding: AxisTrelloBindingIdentity, cardId: string) => Effect.Effect<void>;
}

export class AxisTrelloActionsService extends Context.Service<
  AxisTrelloActionsService,
  AxisTrelloActionsShape
>()("t3/axis/tasks/AxisTrelloActions/AxisTrelloActionsService") {}

const snapshotKey = (binding: AxisTrelloBindingIdentity, cardId: string): string =>
  `${binding.contextId}::${binding.provider.environmentId}::${binding.provider.instanceId}::${cardId}`;

const digestComment = (input: PostTrelloCommentInput): string =>
  `${input.sourceCardId}|${input.body.length}`;

const digestMove = (input: MoveTrelloCardInput): string => `${input.sourceCardId}|${input.listId}`;

interface MutableTrelloActionsState {
  readonly intents: Map<string, AxisTrelloIntentRecord>;
  readonly snapshots: Map<string, AxisTrelloConfirmedSnapshot>;
  readonly revokedKeys: Set<string>;
}

export const makeAxisTrelloActionsLive = Effect.gen(function* () {
  const stateRef = yield* Ref.make<MutableTrelloActionsState>({
    intents: new Map(),
    snapshots: new Map(),
    revokedKeys: new Set(),
  });
  const adapter = yield* AxisTrelloWriteAdapterService;

  const guard = (
    binding: AxisTrelloBindingIdentity,
    cardId: string,
  ): Effect.Effect<void, AxisTrelloIntentRevokedError> =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      if (state.revokedKeys.has(snapshotKey(binding, cardId))) {
        return yield* Effect.fail(
          new AxisTrelloIntentRevokedError({
            message: "Trello binding has been revoked for this card.",
          }),
        );
      }
    });

  const markConfirmed = (
    binding: AxisTrelloBindingIdentity,
    record: AxisTrelloIntentRecord,
    result:
      | { readonly kind: "postComment"; readonly commentId: string }
      | { readonly kind: "moveCard"; readonly listId: string },
    at: string,
  ): Effect.Effect<AxisTrelloConfirmedSnapshot> =>
    Effect.gen(function* () {
      const snapshot: AxisTrelloConfirmedSnapshot = {
        cardId: record.cardId,
        lastConfirmedAt: at,
        lastIntentId: record.intentId,
        lastAction: record.action,
        ...(result.kind === "postComment" ? { commentId: result.commentId } : {}),
        ...(result.kind === "moveCard" ? { listId: result.listId } : {}),
      };
      yield* Ref.update(stateRef, (state) => ({
        ...state,
        intents: new Map(state.intents).set(record.intentId, {
          ...record,
          status: "confirmed" as const,
        }),
        snapshots: new Map(state.snapshots).set(snapshotKey(binding, record.cardId), snapshot),
      }));
      return snapshot;
    });

  const reconcile = (
    binding: AxisTrelloBindingIdentity,
    record: AxisTrelloIntentRecord,
    bodyDigest: string,
  ): Effect.Effect<TrelloActionResult | null, AxisTrelloIntentStaleError> =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const existing = state.intents.get(record.intentId);
      if (existing !== undefined) {
        if (existing.status === "confirmed" && existing.bodyDigest === bodyDigest) {
          const snapshot = state.snapshots.get(snapshotKey(binding, record.cardId));
          if (snapshot !== undefined && snapshot.lastIntentId === record.intentId) {
            return {
              intentId: record.intentId,
              snapshot,
              alreadyConfirmed: true,
            };
          }
        }
        if (existing.bodyDigest !== bodyDigest) {
          return yield* Effect.fail(
            new AxisTrelloIntentStaleError({
              message: `Trello intent ${record.intentId} was previously recorded with different payload.`,
            }),
          );
        }
      }
      return null;
    });

  const postComment = (
    input: PostTrelloCommentInput,
  ): Effect.Effect<
    TrelloActionResult,
    AxisTrelloError | AxisTrelloIntentRevokedError | AxisTrelloIntentStaleError
  > =>
    Effect.gen(function* () {
      yield* guard(input.binding, input.sourceCardId);
      const intentId = AxisTrelloIntentId.make(trelloIntentId(input.commandId, input.sourceCardId));
      const record: AxisTrelloIntentRecord = {
        intentId,
        commandId: input.commandId,
        cardId: input.sourceCardId,
        action: "add-comment",
        bodyDigest: digestComment(input),
        createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
        status: "pending",
      };
      const replay = yield* reconcile(input.binding, record, record.bodyDigest);
      if (replay !== null) return replay;
      yield* Ref.update(stateRef, (state) => ({
        ...state,
        intents: new Map(state.intents).set(intentId, record),
      }));
      const result = yield* adapter.addComment(input.binding, {
        cardId: input.sourceCardId,
        body: input.body,
      } as AxisTrelloCommentInput);
      const snapshot = yield* markConfirmed(
        input.binding,
        record,
        { kind: "postComment", commentId: result.commentId },
        DateTime.formatIso(DateTime.nowUnsafe()),
      );
      return { intentId, snapshot, alreadyConfirmed: false };
    });

  const moveCard = (
    input: MoveTrelloCardInput,
  ): Effect.Effect<
    TrelloActionResult,
    AxisTrelloError | AxisTrelloIntentRevokedError | AxisTrelloIntentStaleError
  > =>
    Effect.gen(function* () {
      yield* guard(input.binding, input.sourceCardId);
      const intentId = AxisTrelloIntentId.make(trelloIntentId(input.commandId, input.sourceCardId));
      const record: AxisTrelloIntentRecord = {
        intentId,
        commandId: input.commandId,
        cardId: input.sourceCardId,
        action: "move-list",
        bodyDigest: digestMove(input),
        createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
        status: "pending",
      };
      const replay = yield* reconcile(input.binding, record, record.bodyDigest);
      if (replay !== null) return replay;
      yield* Ref.update(stateRef, (state) => ({
        ...state,
        intents: new Map(state.intents).set(intentId, record),
      }));
      const moveInput: AxisTrelloMoveCardInput = {
        cardId: input.sourceCardId,
        targetListId: input.listId,
      };
      const result = yield* adapter.moveCard(input.binding, moveInput);
      // Use the LIST ID returned by the adapter — never substitute the
      // Axis-side column label. This preserves the native board/list
      // identity even when the user typed an alias.
      const snapshot = yield* markConfirmed(
        input.binding,
        record,
        { kind: "moveCard", listId: result.listId },
        DateTime.formatIso(DateTime.nowUnsafe()),
      );
      return { intentId, snapshot, alreadyConfirmed: false };
    });

  const getSnapshot = (
    binding: AxisTrelloBindingIdentity,
    cardId: string,
  ): Effect.Effect<Option.Option<AxisTrelloConfirmedSnapshot>> =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const found = state.snapshots.get(snapshotKey(binding, cardId));
      return found === undefined ? Option.none() : Option.some(found);
    });

  const revoke = (binding: AxisTrelloBindingIdentity, cardId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* Ref.update(stateRef, (state) => ({
        ...state,
        revokedKeys: new Set(state.revokedKeys).add(snapshotKey(binding, cardId)),
      }));
    });

  return { postComment, moveCard, getSnapshot, revoke };
});

export const AxisTrelloActionsLive: Layer.Layer<
  AxisTrelloActionsService,
  never,
  AxisTrelloWriteAdapterService
> = Layer.effect(AxisTrelloActionsService, makeAxisTrelloActionsLive);

export const makeAxisTrelloActionsWith = (
  adapter: AxisTrelloWriteAdapter,
): Layer.Layer<AxisTrelloActionsService> =>
  AxisTrelloActionsLive.pipe(Layer.provide(Layer.succeed(AxisTrelloWriteAdapterService, adapter)));

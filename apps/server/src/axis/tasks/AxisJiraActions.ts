/**
 * AxisJiraActions - Authoritative Jira write coordinator for Axis workflows.
 *
 * Sits between the workflow layer (W07/W09) and the AxisJiraAdapter transport
 * contract (testable). The actions module owns:
 *
 *  - Idempotency via source-keyed `intentId` (commandId + issueKey).
 *  - Reconciliation: an answer received for an older intent is treated as
 *    stale and surfaced; never silently overwrites the last confirmed snapshot.
 *  - Connection / cancellation guards that refuse writes when the binding is
 *    revoked or the context binding no longer matches.
 *
 * No Jira network access is performed here. The implementation defers to
 * `AxisJiraAdapter`, which is the only layer that talks to a real Jira
 * transport; the smoke environment uses `makeAxisJiraAdapterNoop` and
 * external smoke runs must obtain explicit authorisation before exercising a
 * real Jira tenant.
 *
 * The local snapshot remains the source of truth. A failed write preserves
 * the last confirmed state, so callers can decide whether to retry, escalate
 * or request fresh confirmation from the human.
 */
import { CommandId, EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  type AxisJiraAdapter,
  AxisJiraAdapterService,
  type AxisJiraBindingIdentity,
  type AxisJiraCommentPlacement,
  type AxisJiraError,
  type AxisJiraIssueCommentInput,
  type AxisJiraIssueTransitionInput,
  type AxisJiraTransition,
} from "./AxisJiraAdapter.ts";

const jiraIntentId = (commandId: CommandId, issueKey: string): string =>
  `jira-intent:${commandId}:${issueKey}`;

const jiraIntentKeyRegex = /^jira-intent:[A-Za-z0-9][A-Za-z0-9_-]*:[A-Z][A-Z0-9_]+-\d+$/u;

export const AxisJiraIntentId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(jiraIntentKeyRegex),
).pipe(Schema.brand("AxisJiraIntentId"));
export type AxisJiraIntentId = typeof AxisJiraIntentId.Type;

export const AxisJiraIntentRecord = Schema.Struct({
  intentId: AxisJiraIntentId,
  commandId: CommandId,
  issueKey: Schema.String,
  operation: Schema.Literals(["postComment", "transitionIssue"]),
  bodyDigest: Schema.String,
  createdAt: Schema.String,
  status: Schema.Literals(["pending", "confirmed", "stale", "failed"]),
});
export type AxisJiraIntentRecord = typeof AxisJiraIntentRecord.Type;

export const AxisJiraConfirmedSnapshot = Schema.Struct({
  issueKey: Schema.String,
  lastConfirmedAt: Schema.String,
  lastIntentId: AxisJiraIntentId,
  lastOperation: Schema.Literals(["postComment", "transitionIssue"]),
  lastState: Schema.optional(Schema.String),
  lastCommentId: Schema.optional(Schema.String),
});
export type AxisJiraConfirmedSnapshot = typeof AxisJiraConfirmedSnapshot.Type;

export class AxisJiraIntentRevokedError extends Schema.TaggedErrorClass<{
  readonly _tag: "AxisJiraIntentRevokedError";
  readonly message: string;
}>()("AxisJiraIntentRevokedError", { message: Schema.String }) {}

export class AxisJiraIntentStaleError extends Schema.TaggedErrorClass<{
  readonly _tag: "AxisJiraIntentStaleError";
  readonly message: string;
}>()("AxisJiraIntentStaleError", { message: Schema.String }) {}

export interface PostJiraCommentInput {
  readonly binding: AxisJiraBindingIdentity;
  readonly sourceIssueKey: string;
  readonly body: string;
  readonly placement: AxisJiraCommentPlacement;
  readonly commandId: CommandId;
}

export interface TransitionJiraIssueInput {
  readonly binding: AxisJiraBindingIdentity;
  readonly sourceIssueKey: string;
  readonly transition: AxisJiraTransition;
  readonly note?: string;
  readonly commandId: CommandId;
}

export interface JiraActionResult {
  readonly intentId: AxisJiraIntentId;
  readonly snapshot: AxisJiraConfirmedSnapshot;
  readonly alreadyConfirmed: boolean;
}

export interface AxisJiraActionsShape {
  readonly postComment: (
    input: PostJiraCommentInput,
  ) => Effect.Effect<
    JiraActionResult,
    AxisJiraError | AxisJiraIntentRevokedError | AxisJiraIntentStaleError
  >;
  readonly transitionIssue: (
    input: TransitionJiraIssueInput,
  ) => Effect.Effect<
    JiraActionResult,
    AxisJiraError | AxisJiraIntentRevokedError | AxisJiraIntentStaleError
  >;
  readonly getSnapshot: (
    binding: AxisJiraBindingIdentity,
    issueKey: string,
  ) => Effect.Effect<Option.Option<AxisJiraConfirmedSnapshot>>;
  readonly revoke: (binding: AxisJiraBindingIdentity, issueKey: string) => Effect.Effect<void>;
}

export class AxisJiraActionsService extends Context.Service<
  AxisJiraActionsService,
  AxisJiraActionsShape
>()("t3/axis/tasks/AxisJiraActions/AxisJiraActionsService") {}

const snapshotKey = (binding: AxisJiraBindingIdentity, issueKey: string): string =>
  `${binding.contextId}::${binding.provider.environmentId}::${binding.provider.instanceId}::${issueKey}`;

const digestBody = (input: AxisJiraIssueCommentInput): string =>
  `${input.issueKey}|${input.placement}|${input.body.length}`;

const digestTransition = (input: AxisJiraIssueTransitionInput): string =>
  `${input.issueKey}|${input.transition}|${(input.note ?? "").length}`;

interface MutableJiraActionsState {
  readonly intents: Map<string, AxisJiraIntentRecord>;
  readonly snapshots: Map<string, AxisJiraConfirmedSnapshot>;
  readonly revokedKeys: Set<string>;
}

export const makeAxisJiraActionsLive = Effect.gen(function* () {
  const stateRef = yield* Ref.make<MutableJiraActionsState>({
    intents: new Map(),
    snapshots: new Map(),
    revokedKeys: new Set(),
  });

  const adapter = yield* AxisJiraAdapterService;

  const guard = (
    binding: AxisJiraBindingIdentity,
    issueKey: string,
  ): Effect.Effect<void, AxisJiraIntentRevokedError> =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      if (state.revokedKeys.has(snapshotKey(binding, issueKey))) {
        return yield* Effect.fail(
          new AxisJiraIntentRevokedError({
            message: "Jira binding has been revoked for this issue.",
          }),
        );
      }
    });

  const markConfirmed = (
    binding: AxisJiraBindingIdentity,
    record: AxisJiraIntentRecord,
    result:
      | { readonly kind: "postComment"; readonly commentId: string }
      | { readonly kind: "transitionIssue"; readonly state: AxisJiraTransition },
    at: string,
  ): Effect.Effect<AxisJiraConfirmedSnapshot> =>
    Effect.gen(function* () {
      const snapshot: AxisJiraConfirmedSnapshot = {
        issueKey: record.issueKey,
        lastConfirmedAt: at,
        lastIntentId: record.intentId,
        lastOperation: record.operation,
        ...(result.kind === "postComment" ? { lastCommentId: result.commentId } : {}),
        ...(result.kind === "transitionIssue" ? { lastState: result.state } : {}),
      };
      yield* Ref.update(stateRef, (state) => ({
        ...state,
        intents: new Map(state.intents).set(record.intentId, {
          ...record,
          status: "confirmed" as const,
        }),
        snapshots: new Map(state.snapshots).set(snapshotKey(binding, record.issueKey), snapshot),
      }));
      return snapshot;
    });

  const reconcile = (
    binding: AxisJiraBindingIdentity,
    record: AxisJiraIntentRecord,
    bodyDigest: string,
  ): Effect.Effect<JiraActionResult | null, AxisJiraIntentStaleError> =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const existing = state.intents.get(record.intentId);
      if (existing !== undefined) {
        if (existing.status === "confirmed" && existing.bodyDigest === bodyDigest) {
          const snapshot = state.snapshots.get(snapshotKey(binding, record.issueKey));
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
            new AxisJiraIntentStaleError({
              message: `Jira intent ${record.intentId} was previously recorded with different payload.`,
            }),
          );
        }
      }
      return null;
    });

  const postComment = (
    input: PostJiraCommentInput,
  ): Effect.Effect<
    JiraActionResult,
    AxisJiraError | AxisJiraIntentRevokedError | AxisJiraIntentStaleError
  > =>
    Effect.gen(function* () {
      yield* guard(input.binding, input.sourceIssueKey);
      const intentId = AxisJiraIntentId.make(jiraIntentId(input.commandId, input.sourceIssueKey));
      const record: AxisJiraIntentRecord = {
        intentId,
        commandId: input.commandId,
        issueKey: input.sourceIssueKey,
        operation: "postComment",
        bodyDigest: digestBody({
          issueKey: input.sourceIssueKey,
          body: input.body,
          placement: input.placement,
        }),
        createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
        status: "pending",
      };
      const replay = yield* reconcile(input.binding, record, record.bodyDigest);
      if (replay !== null) return replay;
      yield* Ref.update(stateRef, (state) => ({
        ...state,
        intents: new Map(state.intents).set(intentId, record),
      }));
      const result = yield* adapter.postComment(input.binding, {
        issueKey: input.sourceIssueKey as never,
        body: input.body,
        placement: input.placement,
      });
      const snapshot = yield* markConfirmed(
        input.binding,
        record,
        { kind: "postComment", commentId: result.commentId },
        DateTime.formatIso(DateTime.nowUnsafe()),
      );
      return { intentId, snapshot, alreadyConfirmed: false };
    });

  const transitionIssue = (
    input: TransitionJiraIssueInput,
  ): Effect.Effect<
    JiraActionResult,
    AxisJiraError | AxisJiraIntentRevokedError | AxisJiraIntentStaleError
  > =>
    Effect.gen(function* () {
      yield* guard(input.binding, input.sourceIssueKey);
      const intentId = AxisJiraIntentId.make(jiraIntentId(input.commandId, input.sourceIssueKey));
      const record: AxisJiraIntentRecord = {
        intentId,
        commandId: input.commandId,
        issueKey: input.sourceIssueKey,
        operation: "transitionIssue",
        bodyDigest: digestTransition({
          issueKey: input.sourceIssueKey,
          transition: input.transition,
          ...(input.note !== undefined ? { note: input.note } : {}),
        }),
        createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
        status: "pending",
      };
      const replay = yield* reconcile(input.binding, record, record.bodyDigest);
      if (replay !== null) return replay;
      yield* Ref.update(stateRef, (state) => ({
        ...state,
        intents: new Map(state.intents).set(intentId, record),
      }));
      const issueCommentInput: AxisJiraIssueTransitionInput = {
        issueKey: input.sourceIssueKey as never,
        transition: input.transition,
        ...(input.note !== undefined ? { note: input.note } : {}),
      };
      const result = yield* adapter.transitionIssue(input.binding, issueCommentInput);
      const snapshot = yield* markConfirmed(
        input.binding,
        record,
        { kind: "transitionIssue", state: result.state },
        DateTime.formatIso(DateTime.nowUnsafe()),
      );
      return { intentId, snapshot, alreadyConfirmed: false };
    });

  const getSnapshot = (
    binding: AxisJiraBindingIdentity,
    issueKey: string,
  ): Effect.Effect<Option.Option<AxisJiraConfirmedSnapshot>> =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const found = state.snapshots.get(snapshotKey(binding, issueKey));
      return found === undefined ? Option.none() : Option.some(found);
    });

  const revoke = (binding: AxisJiraBindingIdentity, issueKey: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* Ref.update(stateRef, (state) => ({
        ...state,
        revokedKeys: new Set(state.revokedKeys).add(snapshotKey(binding, issueKey)),
      }));
    });

  return { postComment, transitionIssue, getSnapshot, revoke };
});

export const AxisJiraActionsLive: Layer.Layer<
  AxisJiraActionsService,
  never,
  AxisJiraAdapterService
> = Layer.effect(AxisJiraActionsService, makeAxisJiraActionsLive);

/** Build an in-memory Jira action set wrapping a custom adapter. */
export const makeAxisJiraActionsWith = (
  adapter: AxisJiraAdapter,
): Layer.Layer<AxisJiraActionsService> =>
  AxisJiraActionsLive.pipe(Layer.provide(Layer.succeed(AxisJiraAdapterService, adapter)));

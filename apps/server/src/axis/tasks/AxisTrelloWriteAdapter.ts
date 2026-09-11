/** Testable Trello write adapter contract.
 * Real implementations bind to the environment-owned MCP Trello capability.
 * The interface is intentionally free of transport; it is supplied per
 * environment and exercised through the AxisWorkHubSourceSync pipeline. */
import {
  AxisCapabilityId,
  AxisContextId,
  AxisTaskSource,
  CommandId,
  EnvironmentId,
  type AxisProviderInstanceLocator,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const ID_MAX = 256;
const URL_MAX = 2_048;
const NAME_MAX = 256;
const NOTE_MAX = 2_000;

export const AxisTrelloCardAction = Schema.Literals([
  "move-list",
  "add-comment",
  "archive",
  "rename",
]);
export type AxisTrelloCardAction = typeof AxisTrelloCardAction.Type;

export const AxisTrelloCardId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isMaxLength(ID_MAX),
);
export type AxisTrelloCardId = typeof AxisTrelloCardId.Type;

export const AxisTrelloListId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isMaxLength(ID_MAX),
);
export type AxisTrelloListId = typeof AxisTrelloListId.Type;

export interface AxisTrelloBindingIdentity {
  readonly environmentId: EnvironmentId;
  readonly contextId: AxisContextId;
  readonly provider: AxisProviderInstanceLocator;
  readonly capabilityId: AxisCapabilityId;
  readonly mcpName: string;
}

export interface AxisTrelloMoveCardInput {
  readonly cardId: AxisTrelloCardId;
  readonly targetListId: AxisTrelloListId;
  readonly reason?: string;
}

export interface AxisTrelloCommentInput {
  readonly cardId: AxisTrelloCardId;
  readonly body: string;
}

export const AxisTrelloConfirmRequiredError = Schema.TaggedErrorClass<{
  readonly _tag: "AxisTrelloConfirmRequiredError";
  readonly message: string;
}>()("AxisTrelloConfirmRequiredError", { message: Schema.String });

export const AxisTrelloSourceMismatchError = Schema.TaggedErrorClass<{
  readonly _tag: "AxisTrelloSourceMismatchError";
  readonly message: string;
}>()("AxisTrelloSourceMismatchError", { message: Schema.String });

export const AxisTrelloTransportError = Schema.TaggedErrorClass<{
  readonly _tag: "AxisTrelloTransportError";
  readonly message: string;
}>()("AxisTrelloTransportError", { message: Schema.String });

export const AxisTrelloError = Schema.Union([
  AxisTrelloConfirmRequiredError,
  AxisTrelloSourceMismatchError,
  AxisTrelloTransportError,
]);
export type AxisTrelloError = typeof AxisTrelloError.Type;

export interface AxisTrelloWriteAdapter {
  readonly moveCard: (
    identity: AxisTrelloBindingIdentity,
    input: AxisTrelloMoveCardInput,
  ) => Effect.Effect<{ readonly cardId: string; readonly listId: string }, AxisTrelloError>;
  readonly addComment: (
    identity: AxisTrelloBindingIdentity,
    input: AxisTrelloCommentInput,
  ) => Effect.Effect<{ readonly cardId: string; readonly commentId: string }, AxisTrelloError>;
  readonly archiveCard: (
    identity: AxisTrelloBindingIdentity,
    cardId: AxisTrelloCardId,
  ) => Effect.Effect<{ readonly cardId: string }, AxisTrelloError>;
}

export class AxisTrelloWriteAdapterService extends Context.Service<AxisTrelloWriteAdapter>()(
  "t3/axis/tasks/AxisTrelloWriteAdapter",
) {}

const assertTrelloSource = (
  source: AxisTaskSource["Type"] | undefined,
  identity: AxisTrelloBindingIdentity,
): Effect.Effect<AxisTrelloCardId, AxisTrelloError> => {
  if (source === undefined || source.kind !== "trello") {
    return Effect.fail(
      new AxisTrelloSourceMismatchError({
        message: "Task source does not identify a Trello card.",
      }),
    );
  }
  if (source.url !== undefined) {
    try {
      const url = new URL(source.url);
      if (url.username.length > 0 || url.password.length > 0) {
        return Effect.fail(
          new AxisTrelloTransportError({
            message: "Trello source URL must not embed credentials.",
          }),
        );
      }
    } catch {
      return Effect.fail(
        new AxisTrelloTransportError({
          message: "Trello source URL is not parseable.",
        }),
      );
    }
  }
  return Effect.succeed(Schema.decodeUnknownSync(AxisTrelloCardId)(source.cardId));
};

export const makeAxisTrelloWriteAdapterNoop = (): AxisTrelloWriteAdapter => ({
  moveCard: (_identity, input) =>
    Effect.succeed({ cardId: input.cardId, listId: input.targetListId }),
  addComment: (_identity, input) =>
    Effect.succeed({
      cardId: input.cardId,
      commentId: `trello-comment-stub:${input.cardId}:${Math.random().toString(36).slice(2, 10)}`,
    }),
  archiveCard: (_identity, cardId) => Effect.succeed({ cardId }),
});

export const withTrelloConfirmation = (
  source: AxisTaskSource["Type"] | undefined,
  identity: AxisTrelloBindingIdentity,
  commandId: CommandId,
  inner: AxisTrelloWriteAdapter,
): AxisTrelloWriteAdapter => ({
  moveCard: (id, input) =>
    Effect.gen(function* () {
      if (id.contextId !== identity.contextId) {
        return yield* Effect.fail(
          new AxisTrelloConfirmRequiredError({
            message: "Trello binding context does not match the task context.",
          }),
        );
      }
      yield* assertTrelloSource(source, identity);
      yield* Effect.annotateCurrentSpan({
        "axis.command.id": commandId,
        "axis.trello.card": input.cardId,
        "axis.trello.target_list": input.targetListId,
      });
      return yield* inner.moveCard(id, input);
    }),
  addComment: (id, input) =>
    Effect.gen(function* () {
      if (id.contextId !== identity.contextId) {
        return yield* Effect.fail(
          new AxisTrelloConfirmRequiredError({
            message: "Trello binding context does not match the task context.",
          }),
        );
      }
      yield* assertTrelloSource(source, identity);
      yield* Effect.annotateCurrentSpan({
        "axis.command.id": commandId,
        "axis.trello.card": input.cardId,
      });
      return yield* inner.addComment(id, input);
    }),
  archiveCard: (id, cardId) =>
    Effect.gen(function* () {
      if (id.contextId !== identity.contextId) {
        return yield* Effect.fail(
          new AxisTrelloConfirmRequiredError({
            message: "Trello binding context does not match the task context.",
          }),
        );
      }
      yield* assertTrelloSource(source, identity);
      yield* Effect.annotateCurrentSpan({
        "axis.command.id": commandId,
        "axis.trello.card": cardId,
      });
      return yield* inner.archiveCard(id, cardId);
    }),
});

export const noopAxisTrelloWriteAdapterLayer = Layer.succeed(
  AxisTrelloWriteAdapterService,
  makeAxisTrelloWriteAdapterNoop(),
);

/** Map an Axis task status to a native Trello list name. The caller
 * configures the per-project statusMap; this helper preserves the
 * unmapped native name when the mapping is absent. */
export const trelloTargetListName = (
  nativeStatus: string | null,
  statusMap: Readonly<Record<string, string>>,
): Option.Option<string> => {
  if (nativeStatus === null) return Option.none();
  const mapped = statusMap[nativeStatus];
  return mapped === undefined ? Option.none() : Option.some(mapped);
};

export const noteLengthCap = NOTE_MAX;
export const idMaxLength = ID_MAX;
export const urlMaxLength = URL_MAX;
export const nameMaxLength = NAME_MAX;

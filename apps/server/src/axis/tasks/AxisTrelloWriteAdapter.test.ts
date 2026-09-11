import { assert, it } from "@effect/vitest";
import {
  AxisCapabilityId,
  AxisContextId,
  AxisTaskSource,
  CommandId,
  EnvironmentId,
  ProviderInstanceId,
  type AxisProviderInstanceLocator,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  AxisTrelloCardId,
  AxisTrelloConfirmRequiredError,
  AxisTrelloListId,
  AxisTrelloSourceMismatchError,
  AxisTrelloTransportError,
  AxisTrelloWriteAdapterService,
  makeAxisTrelloWriteAdapterNoop,
  trelloTargetListName,
  withTrelloConfirmation,
} from "./AxisTrelloWriteAdapter.ts";

const provider: AxisProviderInstanceLocator = {
  environmentId: EnvironmentId.make("env"),
  instanceId: ProviderInstanceId.make("codex"),
};
const identity = {
  environmentId: EnvironmentId.make("env"),
  contextId: AxisContextId.make("company"),
  provider,
  capabilityId: AxisCapabilityId.make("trello"),
  mcpName: "trello-mcp",
};

const trelloSource = (overrides: Partial<AxisTaskSource & { kind: "trello" }> = {}) => ({
  kind: "trello" as const,
  cardId: overrides.cardId ?? "card-1",
  ...(overrides.url === undefined ? {} : { url: overrides.url }),
});

it.effect("Trello write adapter noop returns the same card and list id", () =>
  Effect.gen(function* () {
    const adapter = makeAxisTrelloWriteAdapterNoop();
    const result = yield* adapter.moveCard(identity, {
      cardId: AxisTrelloCardId.make("card-1"),
      targetListId: AxisTrelloListId.make("list-done"),
    });
    assert.equal(result.cardId, "card-1");
    assert.equal(result.listId, "list-done");
  }),
);

it.effect("noop addComment yields a stub comment id", () =>
  Effect.gen(function* () {
    const adapter = makeAxisTrelloWriteAdapterNoop();
    const result = yield* adapter.addComment(identity, {
      cardId: AxisTrelloCardId.make("card-1"),
      body: "Updated by Axis workflow.",
    });
    assert.equal(result.commentId.startsWith("trello-comment-stub:card-1:"), true);
  }),
);

it.effect("noop archiveCard returns the original card id", () =>
  Effect.gen(function* () {
    const adapter = makeAxisTrelloWriteAdapterNoop();
    const result = yield* adapter.archiveCard(identity, AxisTrelloCardId.make("card-1"));
    assert.equal(result.cardId, "card-1");
  }),
);

it.effect("rejects a context mismatch with AxisTrelloConfirmRequiredError", () =>
  Effect.gen(function* () {
    const inner = makeAxisTrelloWriteAdapterNoop();
    const confirmed = withTrelloConfirmation(
      trelloSource(),
      { ...identity, contextId: AxisContextId.make("other-context") },
      CommandId.make("command-trello"),
      inner,
    );
    const error = yield* Effect.flip(
      confirmed.moveCard(identity, {
        cardId: AxisTrelloCardId.make("card-1"),
        targetListId: AxisTrelloListId.make("list-done"),
      }),
    );
    assert.equal(error._tag, "AxisTrelloConfirmRequiredError");
  }),
);

it.effect("rejects a non-Trello task source", () =>
  Effect.gen(function* () {
    const inner = makeAxisTrelloWriteAdapterNoop();
    const confirmed = withTrelloConfirmation(
      { kind: "local", label: "manual" } as unknown as AxisTaskSource,
      identity,
      CommandId.make("command-trello"),
      inner,
    );
    const error = yield* Effect.flip(
      confirmed.addComment(identity, {
        cardId: AxisTrelloCardId.make("card-1"),
        body: "x",
      }),
    );
    assert.equal(error._tag, "AxisTrelloSourceMismatchError");
  }),
);

it.effect("rejects a Trello URL that embeds credentials", () =>
  Effect.gen(function* () {
    const inner = makeAxisTrelloWriteAdapterNoop();
    const confirmed = withTrelloConfirmation(
      trelloSource({ url: "https://user:secret@trello.com/c/card-1" }),
      identity,
      CommandId.make("command-trello"),
      inner,
    );
    const error = yield* Effect.flip(
      confirmed.archiveCard(identity, AxisTrelloCardId.make("card-1")),
    );
    assert.equal(error._tag, "AxisTrelloTransportError");
  }),
);

it.effect("forwards to the inner adapter once confirmation passes", () =>
  Effect.gen(function* () {
    const inner = makeAxisTrelloWriteAdapterNoop();
    const confirmed = withTrelloConfirmation(
      trelloSource({ url: "https://trello.com/c/card-1" }),
      identity,
      CommandId.make("command-trello"),
      inner,
    );
    const result = yield* confirmed.moveCard(identity, {
      cardId: AxisTrelloCardId.make("card-1"),
      targetListId: AxisTrelloListId.make("list-review"),
    });
    assert.equal(result.listId, "list-review");
  }),
);

it.effect("trelloTargetListName returns mapped name or none", () =>
  Effect.gen(function* () {
    const mapped = trelloTargetListName("Done", { Done: "Done", Todo: "Backlog" });
    assert.equal(Option.getOrThrow(mapped), "Done");
    const unmapped = trelloTargetListName("Custom", { Done: "Done" });
    assert.equal(Option.isNone(unmapped), true);
    const empty = trelloTargetListName(null, {});
    assert.equal(Option.isNone(empty), true);
  }),
);

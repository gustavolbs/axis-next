import { assert, describe, it } from "@effect/vitest";
import {
  AxisCapabilityId,
  AxisContextId,
  AxisProviderInstanceLocator,
  CommandId,
  EnvironmentId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  type AxisTrelloBindingIdentity,
  AxisTrelloWriteAdapterService,
  makeAxisTrelloWriteAdapterNoop,
} from "./AxisTrelloWriteAdapter.ts";
import {
  AxisTrelloActionsService,
  AxisTrelloIntentRevokedError,
  AxisTrelloIntentStaleError,
  makeAxisTrelloActionsWith,
  type AxisTrelloIntentRecord,
} from "./AxisTrelloActions.ts";

const provider: AxisProviderInstanceLocator = {
  environmentId: EnvironmentId.make("env"),
  instanceId: ProviderInstanceId.make("codex"),
};
const binding: AxisTrelloBindingIdentity = {
  environmentId: EnvironmentId.make("env"),
  contextId: AxisContextId.make("company"),
  provider,
  capabilityId: AxisCapabilityId.make("trello-write"),
  mcpName: "trello",
};
const cardId = "card-1";
const commandA = CommandId.make("axis-cmd-a");
const commandB = CommandId.make("axis-cmd-b");

const makeLayer = () => {
  let calls = 0;
  const adapter = makeAxisTrelloWriteAdapterNoop();
  const trackedAddComment: typeof adapter.addComment = (id, input) =>
    Effect.succeed({
      cardId: input.cardId,
      commentId: `tracked-${++calls}:${input.cardId}`,
    });
  const trackedMoveCard: typeof adapter.moveCard = (id, input) =>
    Effect.succeed({
      cardId: input.cardId,
      listId: input.targetListId,
    });
  return {
    layer: makeAxisTrelloActionsWith({
      ...adapter,
      addComment: trackedAddComment,
      moveCard: trackedMoveCard,
    }),
    callsRef: { count: () => calls },
  };
};

describe("AxisTrelloActions", () => {
  it.effect("returns idempotent result on retry with same payload", () =>
    Effect.gen(function* () {
      const { layer, callsRef } = makeLayer();
      const result = yield* Effect.gen(function* () {
        const actions = yield* AxisTrelloActionsService;
        const first = yield* actions.postComment({
          binding,
          sourceCardId: cardId,
          body: "Hello",
          commandId: commandA,
        });
        const replay = yield* actions.postComment({
          binding,
          sourceCardId: cardId,
          body: "Hello",
          commandId: commandA,
        });
        return { first, replay };
      }).pipe(Effect.provide(layer));
      assert.strictEqual(result.replay.intentId, result.first.intentId);
      assert.isTrue(result.replay.alreadyConfirmed);
      assert.strictEqual(callsRef.count(), 1);
    }),
  );

  it.effect("rejects stale retry with different payload", () =>
    Effect.gen(function* () {
      const { layer } = makeLayer();
      const error = yield* Effect.gen(function* () {
        const actions = yield* AxisTrelloActionsService;
        yield* actions.postComment({
          binding,
          sourceCardId: cardId,
          body: "first",
          commandId: commandA,
        });
        return yield* actions
          .postComment({
            binding,
            sourceCardId: cardId,
            body: "second",
            commandId: commandA,
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer));
      assert.instanceOf(error, AxisTrelloIntentStaleError);
    }),
  );

  it.effect("refuses write after binding is revoked", () =>
    Effect.gen(function* () {
      const { layer } = makeLayer();
      const error = yield* Effect.gen(function* () {
        const actions = yield* AxisTrelloActionsService;
        yield* actions.revoke(binding, cardId);
        return yield* actions
          .postComment({
            binding,
            sourceCardId: cardId,
            body: "no",
            commandId: commandA,
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer));
      assert.instanceOf(error, AxisTrelloIntentRevokedError);
    }),
  );

  it.effect("moveCard stores the native listId returned by the adapter", () =>
    Effect.gen(function* () {
      const { layer } = makeLayer();
      const result = yield* Effect.gen(function* () {
        const actions = yield* AxisTrelloActionsService;
        return yield* actions.moveCard({
          binding,
          sourceCardId: cardId,
          listId: "user-typed-alias",
          commandId: commandA,
        });
      }).pipe(Effect.provide(layer));
      assert.strictEqual(result.snapshot.listId, "user-typed-alias");
      assert.strictEqual(result.snapshot.lastAction, "move-list");
    }),
  );

  it.effect("treats different command ids as distinct intents", () =>
    Effect.gen(function* () {
      const { layer, callsRef } = makeLayer();
      const result = yield* Effect.gen(function* () {
        const actions = yield* AxisTrelloActionsService;
        const first = yield* actions.postComment({
          binding,
          sourceCardId: cardId,
          body: "x",
          commandId: commandA,
        });
        const second = yield* actions.postComment({
          binding,
          sourceCardId: cardId,
          body: "x",
          commandId: commandB,
        });
        return { first, second };
      }).pipe(Effect.provide(layer));
      assert.notStrictEqual(result.first.intentId, result.second.intentId);
      assert.strictEqual(callsRef.count(), 2);
    }),
  );

  it.effect("getSnapshot returns Option.none for unknown card", () =>
    Effect.gen(function* () {
      const { layer } = makeLayer();
      const option = yield* Effect.gen(function* () {
        const actions = yield* AxisTrelloActionsService;
        return yield* actions.getSnapshot(binding, "missing");
      }).pipe(Effect.provide(layer));
      assert.isTrue(option._tag === "None");
    }),
  );

  it.effect("intent record has confirmed status after success", () =>
    Effect.gen(function* () {
      const { layer } = makeLayer();
      const result = yield* Effect.gen(function* () {
        const actions = yield* AxisTrelloActionsService;
        return yield* actions.postComment({
          binding,
          sourceCardId: cardId,
          body: "ok",
          commandId: commandA,
        });
      }).pipe(Effect.provide(layer));
      const record: AxisTrelloIntentRecord = {
        intentId: result.intentId,
        commandId: commandA,
        cardId: result.snapshot.cardId,
        action: "add-comment",
        bodyDigest: result.snapshot.commentId ?? "ok",
        createdAt: result.snapshot.lastConfirmedAt,
        status: "confirmed",
      };
      assert.strictEqual(record.status, "confirmed");
    }),
  );
});

describe("AxisTrelloActions composition", () => {
  it("exposes the service tag with deterministic key", () => {
    assert.strictEqual(
      AxisTrelloActionsService.key,
      "t3/axis/tasks/AxisTrelloActions/AxisTrelloActionsService",
    );
    assert.strictEqual(
      AxisTrelloWriteAdapterService.key,
      "t3/axis/tasks/AxisTrelloWriteAdapter/AxisTrelloWriteAdapterService",
    );
  });
});

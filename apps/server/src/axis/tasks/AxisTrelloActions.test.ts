import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import {
  type AxisTrelloRemoteAdapter,
  AxisTrelloActionsError,
  applyAxisTrelloAction,
  trelloIntentIdFor,
} from "./AxisTrelloActions.ts";
import { AxisContextId, CommandId, EnvironmentId, ProjectId } from "@t3tools/contracts";

const scope = {
  contextId: AxisContextId.make("ctx-1"),
  project: {
    environmentId: EnvironmentId.make("env-1"),
    projectId: ProjectId.make("proj-1"),
  },
} as const;

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("AxisTrelloActions", (it) => {
  it.effect("creates a comment and reconciles applied state", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 72 });
      const calls = { comment: 0, listComments: 0 };
      const adapter: AxisTrelloRemoteAdapter = {
        comment: (input) => {
          calls.comment += 1;
          return Effect.succeed({ remoteId: "comment-1" });
        },
        move: (input) => Effect.succeed({ remoteId: "move-1", currentList: input.targetList }),
        listComments: (input) => {
          calls.listComments += 1;
          return Effect.succeed([
            { id: "c-1", body: "PR ready for review.", createdAt: "2026-09-11T00:00:00.000Z" },
          ]);
        },
        getCard: (input) => Effect.succeed({ idList: "list-1", name: "Card 1" }),
      };
      const result = yield* applyAxisTrelloAction(adapter, {
        scope,
        cardId: "card-1",
        commandId: CommandId.make("cmd-1"),
        kind: "comment",
        body: "PR ready for review.",
        targetList: null,
        reason: null,
      });
      assert.equal(result.status, "applied");
      assert.equal(result.appliedAt !== null, true);
      assert.equal(calls.comment, 1);
      assert.equal(calls.listComments, 1);
    }),
  );

  it.effect("duplicate commandId collapses to the same intent", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 72 });
      const calls = { comment: 0, move: 0, getCard: 0 };
      const adapter: AxisTrelloRemoteAdapter = {
        comment: (input) => {
          calls.comment += 1;
          return Effect.succeed({ remoteId: "comment-1" });
        },
        move: (input) => {
          calls.move += 1;
          return Effect.succeed({ remoteId: "move-1", currentList: input.targetList });
        },
        listComments: (input) => Effect.succeed([]),
        getCard: (input) => {
          calls.getCard += 1;
          return Effect.succeed({
            idList: input.cardId === "card-2" ? "list-2" : "list-1",
            name: "Card",
          });
        },
      };
      const first = yield* applyAxisTrelloAction(adapter, {
        scope,
        cardId: "card-2",
        commandId: CommandId.make("cmd-move-1"),
        kind: "move",
        body: null,
        targetList: "list-2",
        reason: null,
      });
      const second = yield* applyAxisTrelloAction(adapter, {
        scope,
        cardId: "card-2",
        commandId: CommandId.make("cmd-move-1"),
        kind: "move",
        body: null,
        targetList: "list-2",
        reason: null,
      });
      assert.equal(second.intentId, first.intentId);
      assert.equal(calls.move, 1);
      assert.equal(
        trelloIntentIdFor({
          scope,
          cardId: "card-2",
          commandId: CommandId.make("cmd-move-1"),
          kind: "move",
          body: null,
          targetList: "list-2",
          reason: null,
        }),
        first.intentId,
      );
    }),
  );

  it.effect("missing body on comment is rejected", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 72 });
      const adapter: AxisTrelloRemoteAdapter = {
        comment: () => Effect.succeed({ remoteId: "x" }),
        move: () => Effect.succeed({ remoteId: "x", currentList: "x" }),
        listComments: () => Effect.succeed([]),
        getCard: () => Effect.succeed({ idList: "x", name: "x" }),
      };
      const error = yield* Effect.flip(
        applyAxisTrelloAction(adapter, {
          scope,
          cardId: "card-3",
          commandId: CommandId.make("cmd-3"),
          kind: "comment",
          body: null,
          targetList: null,
          reason: null,
        }),
      );
      assert.instanceOf(error, AxisTrelloActionsError);
      if (Schema.is(AxisTrelloActionsError)(error)) {
        assert.equal(error.reason, "missing_field");
      }
    }),
  );

  it.effect("move action reconciles via the card's current list", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 72 });
      const adapter: AxisTrelloRemoteAdapter = {
        comment: () => Effect.succeed({ remoteId: "x" }),
        move: (input) => Effect.succeed({ remoteId: "move-1", currentList: input.targetList }),
        listComments: () => Effect.succeed([]),
        getCard: () => Effect.succeed({ idList: "list-target", name: "Card" }),
      };
      const result = yield* applyAxisTrelloAction(adapter, {
        scope,
        cardId: "card-4",
        commandId: CommandId.make("cmd-4"),
        kind: "move",
        body: null,
        targetList: "list-target",
        reason: null,
      });
      assert.equal(result.status, "applied");
      assert.equal(result.currentList, "list-target");
    }),
  );
});

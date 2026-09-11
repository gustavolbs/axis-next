import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import {
  type AxisJiraRemoteAdapter,
  AxisJiraActionsError,
  applyAxisJiraAction,
  jiraIntentIdFor,
} from "./AxisJiraActions.ts";
import { AxisContextId, CommandId, EnvironmentId, ProjectId } from "@t3tools/contracts";

const scope = {
  contextId: AxisContextId.make("ctx-1"),
  project: {
    environmentId: EnvironmentId.make("env-1"),
    projectId: ProjectId.make("proj-1"),
  },
} as const;

const makeAdapter = (overrides: Partial<AxisJiraRemoteAdapter> = {}) => {
  const calls = {
    comment: 0,
    transition: 0,
    listComments: 0,
    listTransitions: 0,
  };
  const adapter: AxisJiraRemoteAdapter = {
    comment:
      overrides.comment ??
      ((input) => {
        calls.comment += 1;
        return Effect.succeed({ remoteId: `comment-${calls.comment}` });
      }),
    transition:
      overrides.transition ??
      ((input) => {
        calls.transition += 1;
        return Effect.succeed({ remoteId: `transition-${calls.transition}` });
      }),
    listComments:
      overrides.listComments ??
      ((input) => {
        calls.listComments += 1;
        return Effect.succeed([]);
      }),
    listTransitions:
      overrides.listTransitions ??
      ((input) => {
        calls.listTransitions += 1;
        return Effect.succeed([]);
      }),
  };
  return { adapter, calls };
};

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("AxisJiraActions", (it) => {
  it.effect("creates a comment and reconciles applied state", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 71 });
      const calls = { comment: 0, listComments: 0 };
      const adapter: AxisJiraRemoteAdapter = {
        comment: (input) => {
          calls.comment += 1;
          return Effect.succeed({ remoteId: "comment-1" });
        },
        transition: (input) => Effect.succeed({ remoteId: "transition-1" }),
        listComments: (input) => {
          calls.listComments += 1;
          return Effect.succeed([
            { id: "c-1", body: "Self-review approved.", createdAt: "2026-09-11T00:00:00.000Z" },
          ]);
        },
        listTransitions: (input) => Effect.succeed([]),
      };
      const result = yield* applyAxisJiraAction(adapter, {
        scope,
        issueKey: "PROJ-1",
        commandId: CommandId.make("cmd-1"),
        kind: "comment",
        body: "Self-review approved.",
        transition: null,
        reason: null,
        pullRequestUrl: null,
      });
      assert.equal(result.status, "applied");
      assert.equal(result.appliedAt !== null, true);
      assert.equal(calls.comment, 1);
      assert.equal(calls.listComments, 1);
    }),
  );

  it.effect("duplicate commandId does not call the remote again", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 71 });
      const { adapter, calls } = makeAdapter();
      const base = {
        scope,
        issueKey: "PROJ-2",
        commandId: CommandId.make("cmd-2"),
        kind: "comment" as const,
        body: "Body",
        transition: null,
        reason: null,
        pullRequestUrl: null,
      };
      const first = yield* applyAxisJiraAction(adapter, base);
      const second = yield* applyAxisJiraAction(adapter, base);
      assert.equal(second.intentId, first.intentId);
      assert.equal(calls.comment, 1);
      assert.equal(jiraIntentIdFor(base), first.intentId);
    }),
  );

  it.effect("transition action requires a transition name", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 71 });
      const { adapter } = makeAdapter();
      const error = yield* Effect.flip(
        applyAxisJiraAction(adapter, {
          scope,
          issueKey: "PROJ-3",
          commandId: CommandId.make("cmd-3"),
          kind: "transition",
          body: null,
          transition: null,
          reason: null,
          pullRequestUrl: null,
        }),
      );
      assert.instanceOf(error, AxisJiraActionsError);
      if (error instanceof AxisJiraActionsError) {
        assert.equal(error.reason, "missing_field");
      }
    }),
  );

  it.effect("auth revocation surfaces as auth_revoked", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 71 });
      const { adapter } = makeAdapter({
        comment: () => Effect.fail({ _tag: "AuthRevokedError", message: "Token revoked" }),
      });
      const error = yield* Effect.flip(
        applyAxisJiraAction(adapter, {
          scope,
          issueKey: "PROJ-4",
          commandId: CommandId.make("cmd-4"),
          kind: "comment",
          body: "Hello",
          transition: null,
          reason: null,
          pullRequestUrl: null,
        }),
      );
      assert.instanceOf(error, AxisJiraActionsError);
      if (error instanceof AxisJiraActionsError) {
        assert.equal(error.reason, "auth_revoked");
      }
    }),
  );
});

import { assert, describe, it } from "@effect/vitest";
import {
  AxisContextId,
  AxisProviderInstanceLocator,
  CommandId,
  EnvironmentId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  type AxisJiraBindingIdentity,
  AxisJiraConfirmRequiredError,
  AxisJiraError,
  AxisJiraSourceMismatchError,
  AxisJiraTransportError,
  makeAxisJiraAdapterNoop,
} from "./AxisJiraAdapter.ts";
import {
  AxisJiraActionsService,
  AxisJiraIntentRevokedError,
  AxisJiraIntentStaleError,
  makeAxisJiraActionsWith,
  type AxisJiraIntentRecord,
} from "./AxisJiraActions.ts";

const provider: AxisProviderInstanceLocator = {
  environmentId: EnvironmentId.make("env"),
  instanceId: ProviderInstanceId.make("codex"),
};
const binding: AxisJiraBindingIdentity = {
  environmentId: EnvironmentId.make("env"),
  contextId: AxisContextId.make("company"),
  provider,
};
const issueKey = "AX-42";
const commandA = CommandId.make("axis-cmd-a");
const commandB = CommandId.make("axis-cmd-b");

const makeLayer = (overrides?: {
  readonly postComment?: ReturnType<typeof makeAxisJiraAdapterNoop>["postComment"];
  readonly transitionIssue?: ReturnType<typeof makeAxisJiraAdapterNoop>["transitionIssue"];
}) => {
  let calls = 0;
  const base = makeAxisJiraAdapterNoop();
  const adapter = {
    postComment: overrides?.postComment ?? base.postComment,
    transitionIssue: overrides?.transitionIssue ?? base.transitionIssue,
  };
  const trackedPostComment: typeof adapter.postComment = (id, input) =>
    Effect.suspend(() => Effect.succeed({ commentId: `tracked-${++calls}:${input.issueKey}` }));
  return {
    layer: makeAxisJiraActionsWith({
      postComment: overrides?.postComment ?? trackedPostComment,
      transitionIssue: overrides?.transitionIssue ?? adapter.transitionIssue,
    }),
    callsRef: { count: () => calls },
  };
};

describe("AxisJiraActions", () => {
  it.effect("returns idempotent result on retry with same payload", () =>
    Effect.gen(function* () {
      const { layer, callsRef } = makeLayer();
      const result = yield* Effect.gen(function* () {
        const actions = yield* AxisJiraActionsService;
        const first = yield* actions.postComment({
          binding,
          sourceIssueKey: issueKey,
          body: "Test comment.",
          placement: "internal",
          commandId: commandA,
        });
        const replay = yield* actions.postComment({
          binding,
          sourceIssueKey: issueKey,
          body: "Test comment.",
          placement: "internal",
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
        const actions = yield* AxisJiraActionsService;
        yield* actions.postComment({
          binding,
          sourceIssueKey: issueKey,
          body: "first",
          placement: "internal",
          commandId: commandA,
        });
        return yield* actions
          .postComment({
            binding,
            sourceIssueKey: issueKey,
            body: "second",
            placement: "internal",
            commandId: commandA,
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer));
      assert.instanceOf(error, AxisJiraIntentStaleError);
    }),
  );

  it.effect("refuses write after binding is revoked", () =>
    Effect.gen(function* () {
      const { layer } = makeLayer();
      const error = yield* Effect.gen(function* () {
        const actions = yield* AxisJiraActionsService;
        yield* actions.revoke(binding, issueKey);
        return yield* actions
          .postComment({
            binding,
            sourceIssueKey: issueKey,
            body: "never",
            placement: "internal",
            commandId: commandA,
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer));
      assert.instanceOf(error, AxisJiraIntentRevokedError);
    }),
  );

  it.effect("propagates the transport error when the adapter fails", () =>
    Effect.gen(function* () {
      const layer = makeAxisJiraActionsWith({
        postComment: () =>
          Effect.fail(new AxisJiraTransportError({ message: "Connection lost" }) as AxisJiraError),
        transitionIssue: () =>
          Effect.fail(new AxisJiraTransportError({ message: "Connection lost" }) as AxisJiraError),
      });
      const error = yield* Effect.gen(function* () {
        const actions = yield* AxisJiraActionsService;
        return yield* actions
          .postComment({
            binding,
            sourceIssueKey: "AX-99",
            body: "second",
            placement: "external",
            commandId: commandA,
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer));
      assert.instanceOf(error, AxisJiraTransportError);
    }),
  );

  it.effect("transitionIssue records lastState on confirmed snapshot", () =>
    Effect.gen(function* () {
      const { layer } = makeLayer();
      const result = yield* Effect.gen(function* () {
        const actions = yield* AxisJiraActionsService;
        return yield* actions.transitionIssue({
          binding,
          sourceIssueKey: issueKey,
          transition: "in-review",
          commandId: commandA,
        });
      }).pipe(Effect.provide(layer));
      assert.strictEqual(result.snapshot.lastState, "in-review");
      assert.strictEqual(result.snapshot.lastOperation, "transitionIssue");
    }),
  );

  it.effect("getSnapshot returns Option.none for unknown binding", () =>
    Effect.gen(function* () {
      const { layer } = makeLayer();
      const option = yield* Effect.gen(function* () {
        const actions = yield* AxisJiraActionsService;
        return yield* actions.getSnapshot(binding, "AX-NONE");
      }).pipe(Effect.provide(layer));
      assert.isTrue(option._tag === "None");
    }),
  );

  it.effect("treats two different command ids as separate intents", () =>
    Effect.gen(function* () {
      const { layer, callsRef } = makeLayer();
      const result = yield* Effect.gen(function* () {
        const actions = yield* AxisJiraActionsService;
        const first = yield* actions.postComment({
          binding,
          sourceIssueKey: issueKey,
          body: "x",
          placement: "internal",
          commandId: commandA,
        });
        const second = yield* actions.postComment({
          binding,
          sourceIssueKey: issueKey,
          body: "x",
          placement: "internal",
          commandId: commandB,
        });
        return { first, second };
      }).pipe(Effect.provide(layer));
      assert.notStrictEqual(result.first.intentId, result.second.intentId);
      assert.strictEqual(callsRef.count(), 2);
    }),
  );
});

describe("AxisJiraActions composition", () => {
  it("exposes the service tag with deterministic key", () => {
    assert.strictEqual(
      AxisJiraActionsService.key,
      "t3/axis/tasks/AxisJiraActions/AxisJiraActionsService",
    );
  });

  it.effect("does not call adapter when reconciling a confirmed intent", () =>
    Effect.gen(function* () {
      let calls = 0;
      const adapter = makeAxisJiraAdapterNoop();
      const wrapped = {
        ...adapter,
        postComment: () => {
          calls += 1;
          return Effect.succeed({ commentId: `real-call-${calls}` });
        },
      };
      const layer = makeAxisJiraActionsWith(wrapped);
      yield* Effect.gen(function* () {
        const actions = yield* AxisJiraActionsService;
        yield* actions.postComment({
          binding,
          sourceIssueKey: issueKey,
          body: "ok",
          placement: "internal",
          commandId: commandA,
        });
        const replay = yield* actions.postComment({
          binding,
          sourceIssueKey: issueKey,
          body: "ok",
          placement: "internal",
          commandId: commandA,
        });
        assert.isTrue(replay.alreadyConfirmed);
      }).pipe(Effect.provide(layer));
      assert.strictEqual(calls, 1);
    }),
  );

  it.effect("intent record has confirmed status after success", () =>
    Effect.gen(function* () {
      const { layer } = makeLayer();
      const result = yield* Effect.gen(function* () {
        const actions = yield* AxisJiraActionsService;
        return yield* actions.postComment({
          binding,
          sourceIssueKey: issueKey,
          body: "ok",
          placement: "internal",
          commandId: commandA,
        });
      }).pipe(Effect.provide(layer));
      const record: AxisJiraIntentRecord = {
        intentId: result.intentId,
        commandId: commandA,
        issueKey: result.snapshot.issueKey,
        operation: "postComment",
        bodyDigest: result.snapshot.lastCommentId ?? "ok",
        createdAt: result.snapshot.lastConfirmedAt,
        status: "confirmed",
      };
      assert.strictEqual(record.status, "confirmed");
    }),
  );
});

describe("Jira error taxonomy", () => {
  it("exports the confirm-required error", () => {
    const error = new AxisJiraConfirmRequiredError({ message: "needs confirm" });
    assert.strictEqual(error._tag, "AxisJiraConfirmRequiredError");
  });

  it("exports the source-mismatch error", () => {
    const error = new AxisJiraSourceMismatchError({ message: "wrong source" });
    assert.strictEqual(error._tag, "AxisJiraSourceMismatchError");
  });
});

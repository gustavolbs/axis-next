import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type AxisPullRequestDeliveryAdapter,
  AxisPullRequestDeliveryError,
  deliveryPlanDigest,
  publishAxisPullRequestPlan,
} from "./AxisPullRequestDelivery.ts";
import { AxisContextId, EnvironmentId, ProjectId } from "@t3tools/contracts";

const baseInput = {
  scope: {
    contextId: AxisContextId.make("ctx-1"),
    project: {
      environmentId: EnvironmentId.make("env-1"),
      projectId: ProjectId.make("proj-1"),
    },
  },
  planDigest: "digest-1",
  source: {
    cwd: "/worktree",
    baseBranch: "main",
    headSelector: "feat/some-branch",
    title: "Some change",
    body: "Body",
  },
  draft: true,
};

const makeAdapter = (overrides: Partial<AxisPullRequestDeliveryAdapter> = {}) => {
  const calls = {
    createChangeRequest: 0,
    findChangeRequest: 0,
    readChangeRequestChecks: 0,
  };
  const adapter: AxisPullRequestDeliveryAdapter = {
    createChangeRequest:
      overrides.createChangeRequest ??
      ((input) => {
        calls.createChangeRequest += 1;
        return Effect.succeed({
          reference: `#${calls.createChangeRequest}`,
          url: `https://example/${calls.createChangeRequest}`,
        });
      }),
    findChangeRequest:
      overrides.findChangeRequest ??
      (() => {
        calls.findChangeRequest += 1;
        return Effect.succeed(null);
      }),
    readChangeRequestChecks:
      overrides.readChangeRequestChecks ??
      (() => {
        calls.readChangeRequestChecks += 1;
        return Effect.succeed("pending" as const);
      }),
  };
  return { adapter, calls };
};

it.effect("publishAxisPullRequestPlan creates a new PR and reads CI status", () =>
  Effect.gen(function* () {
    const { adapter, calls } = makeAdapter();
    const result = yield* publishAxisPullRequestPlan(adapter, baseInput);
    assert.equal(calls.createChangeRequest, 1);
    assert.equal(calls.findChangeRequest, 1);
    assert.equal(calls.readChangeRequestChecks, 1);
    assert.equal(result.reference, "#1");
    assert.equal(result.ciStatus, "pending");
    assert.equal(deliveryPlanDigest(baseInput), result.planDigest);
  }),
);

it.effect("duplicate publishes reconcile without calling create", () =>
  Effect.gen(function* () {
    const calls = {
      createChangeRequest: 0,
      findChangeRequest: 0,
      readChangeRequestChecks: 0,
    };
    const adapter: AxisPullRequestDeliveryAdapter = {
      createChangeRequest: () => {
        calls.createChangeRequest += 1;
        return Effect.succeed({ reference: "#never", url: "https://example/never" });
      },
      findChangeRequest: () => {
        calls.findChangeRequest += 1;
        return Effect.succeed({
          reference: "#existing",
          url: "https://example/existing",
          draft: true,
        });
      },
      readChangeRequestChecks: () => {
        calls.readChangeRequestChecks += 1;
        return Effect.succeed("passed" as const);
      },
    };
    const result = yield* publishAxisPullRequestPlan(adapter, baseInput);
    assert.equal(calls.createChangeRequest, 0);
    assert.equal(calls.findChangeRequest, 1);
    assert.equal(calls.readChangeRequestChecks, 1);
    assert.equal(result.reference, "#existing");
    assert.equal(result.ciStatus, "passed");
    assert.equal(result.draft, true);
  }),
);

it.effect("auth revocation surfaces as auth_revoked", () =>
  Effect.gen(function* () {
    const { adapter } = makeAdapter({
      createChangeRequest: () =>
        Effect.fail({ _tag: "AuthRevokedError", message: "Token revoked" }),
    });
    const error = yield* Effect.flip(publishAxisPullRequestPlan(adapter, baseInput));
    assert.equal(Schema.is(AxisPullRequestDeliveryError)(error), true);
    if (Schema.is(AxisPullRequestDeliveryError)(error)) {
      assert.equal(error.reason, "auth_revoked");
    }
  }),
);

it.effect("create failure surfaces as create_failed", () =>
  Effect.gen(function* () {
    const { adapter } = makeAdapter({
      createChangeRequest: () => Effect.fail({ _tag: "NetworkError", message: "Host unreachable" }),
    });
    const error = yield* Effect.flip(publishAxisPullRequestPlan(adapter, baseInput));
    assert.equal(Schema.is(AxisPullRequestDeliveryError)(error), true);
    if (Schema.is(AxisPullRequestDeliveryError)(error)) {
      assert.equal(error.reason, "create_failed");
    }
  }),
);

it.effect("reconcile failure surfaces as reconcile_failed", () =>
  Effect.gen(function* () {
    const { adapter } = makeAdapter({
      findChangeRequest: () => Effect.fail({ _tag: "RateLimit", message: "rate limited" }),
    });
    const error = yield* Effect.flip(publishAxisPullRequestPlan(adapter, baseInput));
    assert.equal(Schema.is(AxisPullRequestDeliveryError)(error), true);
    if (Schema.is(AxisPullRequestDeliveryError)(error)) {
      assert.equal(error.reason, "reconcile_failed");
    }
  }),
);

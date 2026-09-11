// @effect-diagnostics globalErrorInEffectFailure:off - test fixtures fail prepared layers with plain errors.
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import { AxisContextProjectScope, CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { AxisProjectScope } from "../projects/AxisProjectScope.ts";
import { AxisPullRequestPlan } from "./AxisPullRequestPlan.ts";
import {
  AxisPullRequestDeliveryService,
  layer as deliveryLayer,
} from "./AxisPullRequestDelivery.ts";

const scope = Schema.decodeUnknownSync(AxisContextProjectScope)({
  contextId: "company",
  project: { environmentId: "env", projectId: "project" },
});
const caller = { environmentId: "env", contextId: "company" };

const expectedDigestFor = (input: {
  commandId: CommandId;
  currentDiffDigest: string;
  source: string;
  destination: string;
  branch: string;
}) =>
  `sha256:${NodeCrypto.createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex")}`;

const basePlan = (overrides: Partial<AxisPullRequestPlan> = {}): AxisPullRequestPlan => {
  const commandId = CommandId.make("command-publish");
  const currentDiffDigest = "sha256:current";
  const source = "develop";
  const destination = "main";
  const branch = "feature/command-publish";
  const diffDigest = expectedDigestFor({
    commandId,
    currentDiffDigest,
    source,
    destination,
    branch,
  });
  return Schema.decodeUnknownSync(AxisPullRequestPlan)({
    scope,
    commandId,
    projectKey: "project",
    diffDigest,
    source,
    destination,
    branchPolicy: "production-develop",
    branch,
    draft: true,
    status: "draft",
    title: "Add parser error handling",
    body: "Summary",
    template: "minimal",
    applicableRules: [],
    requiredChecks: [],
    blockers: [],
    ...overrides,
  });
};

const CURRENT_DIFF_DIGEST = "sha256:current";

const fakeGit = (
  options: {
    readonly failPrepare?: boolean;
    readonly onPullRequestHead?: boolean;
    readonly state?: "open" | "closed" | "merged";
  } = {},
) =>
  Layer.succeed(GitWorkflowService, {
    preparePullRequestThread: () =>
      options.failPrepare === true
        ? Effect.fail(new Error("prepare failed"))
        : Effect.succeed({
            pullRequest: {
              number: 42,
              title: "Add parser error handling",
              url: "https://example.test/project/pull/42",
              baseBranch: "main",
              headBranch: "feature/command-publish",
              state: options.state ?? "open",
            },
            branch: "feature/command-publish",
            worktreePath: "/tmp/worktree",
            isOnPullRequestHead: options.onPullRequestHead ?? true,
          }),
  } as unknown as GitWorkflowService["Service"]);

const authorizedScope = Layer.succeed(AxisProjectScope, {
  resolveProject: () => Effect.void,
  resolve: () => Effect.void,
} as unknown as AxisProjectScope["Service"]);

const unauthorizedScope = Layer.succeed(AxisProjectScope, {
  resolveProject: () => Effect.fail(new Error("denied")),
  resolve: () => Effect.fail(new Error("denied")),
} as unknown as AxisProjectScope["Service"]);

const buildLayer = (
  gitOptions: Parameters<typeof fakeGit>[0],
  scopeLayer: Layer.Layer<AxisProjectScope> = authorizedScope,
) => deliveryLayer.pipe(Layer.provide(Layer.merge(fakeGit(gitOptions), scopeLayer)));

it.layer(buildLayer({}))("AxisPullRequestDelivery happy path", (it) => {
  it.effect("publishes a plan and returns the publication", () =>
    Effect.gen(function* () {
      const service = yield* AxisPullRequestDeliveryService;
      const plan = basePlan();
      const result = yield* service.deliver(caller, {
        plan,
        cwd: "/tmp/repo",
        planDigest: plan.diffDigest,
        currentDiffDigest: CURRENT_DIFF_DIGEST,
      });
      assert.equal(result.state, "submitted");
      assert.equal(result.url, "https://example.test/project/pull/42");
      assert.equal(result.baseBranch, "main");
      assert.equal(result.headBranch, "feature/command-publish");
    }),
  );

  it.effect("idempotently returns the same publication on repeat delivery", () =>
    Effect.gen(function* () {
      const service = yield* AxisPullRequestDeliveryService;
      const plan = basePlan();
      const input = {
        plan,
        cwd: "/tmp/repo",
        planDigest: plan.diffDigest,
        currentDiffDigest: CURRENT_DIFF_DIGEST,
      };
      const first = yield* service.deliver(caller, input);
      const second = yield* service.deliver(caller, input);
      assert.equal(second.url, first.url);
      assert.equal(second.planDigest, first.planDigest);
    }),
  );

  it.effect("rejects when the plan digest no longer matches the current diff", () =>
    Effect.gen(function* () {
      const service = yield* AxisPullRequestDeliveryService;
      const plan = basePlan();
      const error = yield* Effect.flip(
        service.deliver(caller, {
          plan,
          cwd: "/tmp/repo",
          planDigest: plan.diffDigest,
          currentDiffDigest: "sha256:different",
        }),
      );
      assert.equal(error._tag, "AxisPullRequestDeliveryError");
      assert.equal((error as { reason: string }).reason, "plan_mismatch");
    }),
  );
});

it.layer(buildLayer({ onPullRequestHead: false }))(
  "AxisPullRequestDelivery with head mismatch",
  (it) => {
    it.effect("returns head_mismatch when the local head cannot be checked out", () =>
      Effect.gen(function* () {
        const service = yield* AxisPullRequestDeliveryService;
        const plan = basePlan();
        const error = yield* Effect.flip(
          service.deliver(caller, {
            plan,
            cwd: "/tmp/repo",
            planDigest: plan.diffDigest,
            currentDiffDigest: CURRENT_DIFF_DIGEST,
          }),
        );
        assert.equal(error._tag, "AxisPullRequestDeliveryError");
        assert.equal((error as { reason: string }).reason, "head_mismatch");
      }),
    );
  },
);

it.layer(buildLayer({ failPrepare: true }))("AxisPullRequestDelivery failures", (it) => {
  it.effect("surfaces the prepare error as publish_failed", () =>
    Effect.gen(function* () {
      const service = yield* AxisPullRequestDeliveryService;
      const plan = basePlan();
      const error = yield* Effect.flip(
        service.deliver(caller, {
          plan,
          cwd: "/tmp/repo",
          planDigest: plan.diffDigest,
          currentDiffDigest: CURRENT_DIFF_DIGEST,
        }),
      );
      assert.equal(error._tag, "AxisPullRequestDeliveryError");
      assert.equal((error as { reason: string }).reason, "publish_failed");
    }),
  );
});

it.layer(buildLayer({}, unauthorizedScope))("AxisPullRequestDelivery authorization", (it) => {
  it.effect("rejects unauthorized callers", () =>
    Effect.gen(function* () {
      const service = yield* AxisPullRequestDeliveryService;
      const plan = basePlan();
      const error = yield* Effect.flip(
        service.deliver(caller, {
          plan,
          cwd: "/tmp/repo",
          planDigest: plan.diffDigest,
          currentDiffDigest: CURRENT_DIFF_DIGEST,
        }),
      );
      assert.equal(error._tag, "AxisPullRequestDeliveryError");
      assert.equal((error as { reason: string }).reason, "scope_denied");
    }),
  );
});

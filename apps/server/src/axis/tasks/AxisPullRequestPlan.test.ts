import { assert, it } from "@effect/vitest";
import {
  AxisContextProjectScope,
  AxisProjectRuleId,
  AxisProjectRuleOrigin,
  AxisProjectRuleStrength,
  AxisSkillId,
  CommandId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { AxisProjectProfileStore } from "../projects/AxisProjectProfileStore.ts";
import { AxisPullRequestPlanService, layer as planLayer } from "./AxisPullRequestPlan.ts";
import { AxisProjectProfile } from "@t3tools/contracts";

const scope = Schema.decodeUnknownSync(AxisContextProjectScope)({
  contextId: "company",
  project: { environmentId: "env", projectId: "project" },
});
const baseProfile = (overrides: {
  rules?: AxisProjectProfile["rules"];
  facts?: AxisProjectProfile["facts"];
}): AxisProjectProfile => ({
  scope,
  revision: 0,
  sources: [],
  facts: overrides.facts ?? [],
  rules: overrides.rules ?? [],
  manualDecisions: [],
  workflow: [],
  tokenEfficiencyPolicies: [],
  updatedAt: "2026-09-11T00:00:00.000Z",
});

const buildProfileLayer = (profile: AxisProjectProfile) =>
  Layer.succeed(AxisProjectProfileStore, {
    get: () => Effect.succeed(profile),
    replace: () => Effect.succeed(profile),
    replaceSnapshot: () => Effect.succeed(profile),
    resetOverride: () => Effect.succeed(profile),
  } as unknown as AxisProjectProfileStore["Service"]);

const baseRequest = {
  scope,
  commandId: CommandId.make("command-plan"),
  projectKey: "project",
  diffDigest: "sha256:diff",
  title: "Add parser error handling",
  summary: "Cover malformed input handling on the parser module.",
  touchedPaths: ["apps/server/src/parser.ts"],
};

const productionDevelopRule: AxisProjectProfile["rules"][number] = {
  id: AxisProjectRuleId.make("release-flow"),
  category: "pull-request-policy",
  text: "PR flow: production → develop.",
  origin: AxisProjectRuleOrigin.make("manual"),
  sourceRef: "AGENTS.md",
  sourceRevision: 0,
  paths: [],
  strength: AxisProjectRuleStrength.make("explicit"),
  effect: "restriction",
  restriction: "Open PRs against develop.",
  defaultValue: null,
  condition: null,
};

const envProductionRule: AxisProjectProfile["rules"][number] = {
  id: AxisProjectRuleId.make("monorepo-flow"),
  category: "pull-request-policy",
  text: "Monorepo: main → env/production.",
  origin: AxisProjectRuleOrigin.make("manual"),
  sourceRef: "AGENTS.md",
  sourceRevision: 0,
  paths: [],
  strength: AxisProjectRuleStrength.make("explicit"),
  effect: "restriction",
  restriction: "Open PRs from main into env/production.",
  defaultValue: null,
  condition: null,
};

it.layer(planLayer.pipe(Layer.provide(buildProfileLayer(baseProfile({})))))(
  "AxisPullRequestPlan with empty profile",
  (it) => {
    it.effect("blocks when the profile declares no destination policy", () =>
      Effect.gen(function* () {
        const service = yield* AxisPullRequestPlanService;
        const error = yield* Effect.flip(service.prepare(baseRequest));
        assert.equal(error._tag, "AxisPullRequestPlanError");
        assert.equal((error as { reason: string }).reason, "policy_not_determined");
      }),
    );

    it.effect("accepts an explicit destination override", () =>
      Effect.gen(function* () {
        const service = yield* AxisPullRequestPlanService;
        const plan = yield* service.prepare({
          ...baseRequest,
          destinationOverride: "release/v1",
        });
        assert.equal(plan.destination, "release/v1");
        assert.equal(plan.branchPolicy, "explicit");
      }),
    );
  },
);

it.layer(
  planLayer.pipe(
    Layer.provide(
      buildProfileLayer(
        baseProfile({
          rules: [productionDevelopRule],
        }),
      ),
    ),
  ),
)("AxisPullRequestPlan with production-develop policy", (it) => {
  it.effect("resolves destination to default-branch and source to develop", () =>
    Effect.gen(function* () {
      const service = yield* AxisPullRequestPlanService;
      const plan = yield* service.prepare(baseRequest);
      assert.equal(plan.branchPolicy, "production-develop");
      assert.equal(plan.source, "develop");
      assert.equal(plan.destination, "main");
      assert.equal(plan.status, "ready");
    }),
  );

  it.effect("renders the default template with verification list", () =>
    Effect.gen(function* () {
      const service = yield* AxisPullRequestPlanService;
      const plan = yield* service.prepare(baseRequest);
      assert.equal(plan.template, "default");
      assert.equal(plan.body.includes("## Add parser error handling"), true);
      assert.equal(plan.body.includes("- [ ]"), true);
    }),
  );
});

it.layer(
  planLayer.pipe(
    Layer.provide(
      buildProfileLayer(
        baseProfile({
          rules: [envProductionRule],
        }),
      ),
    ),
  ),
)("AxisPullRequestPlan with main-env/production policy", (it) => {
  it.effect("resolves destination to env/production", () =>
    Effect.gen(function* () {
      const service = yield* AxisPullRequestPlanService;
      const plan = yield* service.prepare(baseRequest);
      assert.equal(plan.branchPolicy, "main-env-production");
      assert.equal(plan.destination, "env/production");
      assert.equal(plan.source, "main");
    }),
  );
});

it.layer(
  planLayer.pipe(
    Layer.provide(
      buildProfileLayer(
        baseProfile({
          rules: [
            {
              id: AxisProjectRuleId.make("release-flow"),
              category: "pull-request-policy",
              text: "Use a release-specific branch for production hotfixes.",
              origin: AxisProjectRuleOrigin.make("manual"),
              sourceRef: "AGENTS.md",
              sourceRevision: 0,
              paths: [],
              strength: AxisProjectRuleStrength.make("explicit"),
              effect: "restriction",
              restriction: "release-specific",
              defaultValue: null,
              condition: null,
            },
          ],
        }),
      ),
    ),
  ),
)("AxisPullRequestPlan with release-specific policy", (it) => {
  it.effect("uses a release branch name and forces env/production destination", () =>
    Effect.gen(function* () {
      const service = yield* AxisPullRequestPlanService;
      const plan = yield* service.prepare(baseRequest);
      assert.equal(plan.branchPolicy, "release-specific");
      assert.equal(plan.destination, "env/production");
      assert.equal(plan.branch.startsWith("release/"), true);
    }),
  );
});

it.layer(
  planLayer.pipe(
    Layer.provide(
      buildProfileLayer(
        baseProfile({
          rules: [
            {
              id: AxisProjectRuleId.make("vinyl-style"),
              category: "convention",
              text: "Preserve vinyl/ styling for the design system.",
              origin: AxisProjectRuleOrigin.make("manual"),
              sourceRef: "vinyl/README.md",
              sourceRevision: 0,
              paths: ["vinyl/**"],
              strength: AxisProjectRuleStrength.make("explicit"),
              effect: "restriction",
              restriction: null,
              defaultValue: null,
              condition: null,
            },
            productionDevelopRule,
          ],
        }),
      ),
    ),
  ),
)("AxisPullRequestPlan with scoped rules", (it) => {
  it.effect("does not apply vinyl rule to unrelated paths", () =>
    Effect.gen(function* () {
      const service = yield* AxisPullRequestPlanService;
      const plan = yield* service.prepare(baseRequest);
      assert.equal(plan.branchPolicy, "production-develop");
      assert.equal(plan.applicableRules.length, 1);
      assert.equal(plan.applicableRules[0]?.id, "release-flow");
    }),
  );

  it.effect("applies a vinyl-scoped rule when the touched path is inside vinyl", () =>
    Effect.gen(function* () {
      const service = yield* AxisPullRequestPlanService;
      const plan = yield* service.prepare({
        ...baseRequest,
        touchedPaths: ["vinyl/components/Button.tsx"],
      });
      assert.equal(plan.applicableRules.length, 2);
      assert.equal(
        plan.applicableRules.some((rule) => rule.id === "vinyl-style"),
        true,
      );
    }),
  );
});

it.layer(
  planLayer.pipe(
    Layer.provide(
      buildProfileLayer(
        baseProfile({
          rules: [productionDevelopRule],
          facts: [
            {
              kind: "value",
              key: "release-notes",
              value: "Bump changelog",
              sourceRef: "AGENTS.md",
            },
          ],
        }),
      ),
    ),
  ),
)("AxisPullRequestPlan with facts", (it) => {
  it.effect("ignores unrelated fact keys when resolving branches", () =>
    Effect.gen(function* () {
      const service = yield* AxisPullRequestPlanService;
      const plan = yield* service.prepare(baseRequest);
      assert.equal(plan.destination, "main");
      assert.equal(plan.branchPolicy, "production-develop");
    }),
  );
});

it.layer(planLayer.pipe(Layer.provide(buildProfileLayer(baseProfile({})))))(
  "AxisPullRequestPlan draft and blockers",
  (it) => {
    it.effect("marks the plan as draft when forceDraft is true", () =>
      Effect.gen(function* () {
        const service = yield* AxisPullRequestPlanService;
        const plan = yield* service.prepare({
          ...baseRequest,
          destinationOverride: "release/v2",
          forceDraft: true,
        });
        assert.equal(plan.draft, true);
        assert.equal(plan.status, "draft");
      }),
    );

    it.effect("blocks the plan when touched paths are missing", () =>
      Effect.gen(function* () {
        const service = yield* AxisPullRequestPlanService;
        const plan = yield* service.prepare({
          ...baseRequest,
          destinationOverride: "release/v2",
          touchedPaths: [],
        });
        assert.equal(plan.status, "blocked");
        assert.equal(plan.blockers.length > 0, true);
      }),
    );
  },
);

it.layer(planLayer.pipe(Layer.provide(buildProfileLayer(baseProfile({})))))(
  "AxisPullRequestPlan input validation",
  (it) => {
    it.effect("rejects invalid input shapes", () =>
      Effect.gen(function* () {
        const service = yield* AxisPullRequestPlanService;
        const error = yield* Effect.flip(
          service.prepare({
            ...baseRequest,
            title: "",
          }),
        );
        assert.equal(error._tag, "AxisPullRequestPlanError");
        assert.equal((error as { reason: string }).reason, "invalid_input");
      }),
    );
  },
);

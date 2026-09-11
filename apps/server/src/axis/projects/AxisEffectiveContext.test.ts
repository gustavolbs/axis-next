import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  AxisCapabilityId,
  AxisContextProjectScope,
  ProviderInstanceId,
  ProviderDriverKind,
  TokenEfficiencyEngineId,
} from "@t3tools/contracts";
import { AxisContextCatalogStore } from "../contexts/AxisContextCatalogStore.ts";
import { AxisLearningStore } from "../learning/AxisLearningStore.ts";
import { AxisProjectProfileStore } from "./AxisProjectProfileStore.ts";
import { AxisProjectScope, AxisProjectScopeResolutionError } from "./AxisProjectScope.ts";
import {
  AxisEffectiveContext,
  make,
  type AxisEffectiveContextInput,
} from "./AxisEffectiveContext.ts";
import type {
  AxisLearningScope,
  AxisLearningSnapshot,
  AxisProjectProfile,
} from "@t3tools/contracts";

const decodeScope = Schema.decodeUnknownSync(AxisContextProjectScope);
const scope = decodeScope({
  contextId: "company",
  project: { environmentId: "env", projectId: "project" },
});
const provider = { environmentId: "env", instanceId: "codex" } as never;
const otherProvider = { environmentId: "env", instanceId: "claude" } as never;
const profile = {
  scope,
  revision: 4,
  sources: [],
  facts: [],
  rules: [
    {
      id: "policy",
      category: "test-policy",
      text: "Run tests.",
      origin: "manifest",
      sourceRef: "manifest",
      sourceRevision: 1,
      paths: ["src"],
      strength: "explicit",
      effect: "restriction",
      restriction: "Tests are required.",
      defaultValue: null,
      condition: null,
    },
  ],
  manualDecisions: [],
  workflow: [],
  tokenEfficiencyPolicies: [
    { providerInstanceId: "codex", model: "gpt-5", engine: "deterministic", mode: "compress" },
  ],
  updatedAt: "2026-09-05T00:00:00.000Z",
} as never as AxisProjectProfile;

const makeScope = (projectId: string) =>
  decodeScope({
    contextId: "company",
    project: { environmentId: "env", projectId },
  });
const withCaller = (
  input: Omit<AxisEffectiveContextInput, "caller" | "driver">,
): AxisEffectiveContextInput => ({
  caller: {
    environmentId: input.scope.project.environmentId,
    contextId: input.scope.contextId,
  },
  driver: ProviderDriverKind.make("codex"),
  ...input,
});

const manifestPreferenceRule = {
  ...profile.rules[0],
  id: "precedence",
  text: "Manifest preference.",
  origin: "manifest",
  effect: "preference",
  restriction: null,
};
const manualPreferenceRule = {
  ...manifestPreferenceRule,
  text: "Manual preference.",
  origin: "manual",
};
const manifestRestrictionRule = {
  ...profile.rules[0],
  id: "protected",
  text: "Manifest restriction.",
  restriction: "The manifest restriction remains required.",
};
const manualRelaxingRule = {
  ...manifestRestrictionRule,
  text: "Manual preference.",
  origin: "manual",
  effect: "preference",
  restriction: null,
};
const profileByProject = new Map<string, AxisProjectProfile>([
  [
    "manifest-first",
    {
      ...profile,
      scope: makeScope("manifest-first"),
      rules: [
        manifestPreferenceRule,
        manualPreferenceRule,
        manifestRestrictionRule,
        manualRelaxingRule,
      ],
    } as never,
  ],
  [
    "manual-first",
    {
      ...profile,
      scope: makeScope("manual-first"),
      rules: [
        manualPreferenceRule,
        manifestPreferenceRule,
        manualRelaxingRule,
        manifestRestrictionRule,
      ],
    } as never,
  ],
]);
const tokenOrderScope = makeScope("token-order");
const tokenOrderPolicies: AxisProjectProfile["tokenEfficiencyPolicies"] = [
  {
    providerInstanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5",
    engine: TokenEfficiencyEngineId.make("deterministic"),
    mode: "compress",
  },
  {
    providerInstanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5",
    engine: TokenEfficiencyEngineId.make("deterministic"),
    mode: "record",
  },
  {
    providerInstanceId: ProviderInstanceId.make("codex"),
    model: "gpt-4",
    engine: TokenEfficiencyEngineId.make("deterministic"),
    mode: "record",
  },
];
profileByProject.set("token-order", {
  ...profile,
  scope: tokenOrderScope,
  tokenEfficiencyPolicies: tokenOrderPolicies,
});
profileByProject.set("trailing-slash", {
  ...profile,
  scope: makeScope("trailing-slash"),
  rules: [{ ...profile.rules[0]!, paths: ["vinyl/"] }],
});

const snapshot = {
  contextId: "company",
  evidence: [],
  proposals: [],
  versions: [
    {
      id: "learning_1",
      proposalId: "proposal_1",
      contextId: "company",
      scope,
      kind: "provider-skill",
      targetKey: "provider:codex:step:verify",
      title: "Add lint",
      rationale: "Repeated correction",
      evidenceIds: ["evidence_1"],
      change: {
        op: "set-rule",
        rule: {
          id: "lint",
          category: "test-policy",
          text: "Run lint.",
          origin: "learning",
          sourceRef: "learning",
          sourceRevision: 1,
          paths: ["src"],
          strength: "inferred",
          effect: "preference",
          restriction: null,
          defaultValue: null,
          condition: null,
        },
      },
      approvedBy: "owner",
      createdAt: "2026-09-05T00:00:00.000Z",
    },
    {
      id: "learning_workflow",
      proposalId: "proposal_workflow",
      contextId: "company",
      scope,
      kind: "workflow-recommendation",
      targetKey: "provider:codex:step:verify",
      title: "Require focused verification",
      rationale: "Verification is part of the workflow.",
      evidenceIds: ["evidence_1"],
      change: {
        op: "set-workflow-step",
        step: {
          id: "verify",
          title: "Verify",
          instruction: "Run focused tests.",
          required: true,
          order: 0,
        },
      },
      approvedBy: "owner",
      createdAt: "2026-09-05T00:00:00.000Z",
    },
    {
      id: "learning_instruction",
      proposalId: "proposal_instruction",
      contextId: "company",
      scope,
      kind: "provider-instructions",
      targetKey: "provider:codex:step:verify",
      title: "Provider instruction",
      rationale: "The provider needs the verification instruction.",
      evidenceIds: ["evidence_1"],
      change: {
        op: "set-provider-instruction",
        capabilityId: "capability",
        instruction: "Use focused tests.",
      },
      approvedBy: "owner",
      createdAt: "2026-09-05T00:00:00.000Z",
    },
    {
      id: "learning_tokens",
      proposalId: "proposal_tokens",
      contextId: "company",
      scope,
      kind: "workflow-recommendation",
      targetKey: "provider:codex:step:verify",
      title: "Token efficiency",
      rationale: "The provider can compress context.",
      evidenceIds: ["evidence_1"],
      change: {
        op: "set-token-efficiency-policy",
        providerInstanceId: "codex",
        model: "gpt-5",
        engine: "deterministic",
        mode: "record",
      },
      approvedBy: "owner",
      createdAt: "2026-09-05T00:00:00.000Z",
    },
  ],
  activeVersions: [],
  activeStates: [
    {
      scope,
      targetKey: "provider:codex:step:verify",
      versionId: "learning_1",
      revision: 1,
      updatedAt: "2026-09-05T00:00:00.000Z",
    },
    {
      scope,
      targetKey: "provider:codex:step:verify",
      versionId: "learning_workflow",
      revision: 1,
      updatedAt: "2026-09-05T00:00:00.000Z",
    },
    {
      scope,
      targetKey: "provider:codex:step:verify",
      versionId: "learning_instruction",
      revision: 1,
      updatedAt: "2026-09-05T00:00:00.000Z",
    },
    {
      scope,
      targetKey: "provider:codex:step:verify",
      versionId: "learning_tokens",
      revision: 1,
      updatedAt: "2026-09-05T00:00:00.000Z",
    },
  ],
  lifecycle: [],
} as never as AxisLearningSnapshot;
const relaxationSnapshot = {
  ...snapshot,
  versions: [
    ...snapshot.versions,
    {
      id: "learning_relax_protected",
      proposalId: "proposal_relax_protected",
      contextId: "company",
      scope,
      kind: "provider-skill",
      targetKey: "provider:codex:step:verify",
      title: "Relax protected rule",
      rationale: "This change must remain blocked.",
      evidenceIds: ["evidence_1"],
      change: {
        op: "set-rule",
        rule: {
          ...manualRelaxingRule,
          origin: "learning",
        },
      },
      approvedBy: "owner",
      createdAt: "2026-09-05T00:00:00.000Z",
    },
  ],
  activeStates: [
    ...snapshot.activeStates,
    {
      scope,
      targetKey: "provider:codex:step:verify",
      versionId: "learning_relax_protected",
      revision: 1,
      updatedAt: "2026-09-05T00:00:00.000Z",
    },
  ],
} as never as AxisLearningSnapshot;
const learnedTokenVersion = snapshot.versions.find((version) => version.id === "learning_tokens")!;
const learnedTokenState = snapshot.activeStates.find(
  (state) => state.versionId === "learning_tokens",
)!;
const incompatibleModelSnapshot = {
  ...snapshot,
  versions: [
    ...snapshot.versions,
    {
      ...learnedTokenVersion,
      id: "learning_tokens_incompatible",
      proposalId: "proposal_tokens_incompatible",
      change: { ...learnedTokenVersion.change, model: "gpt-4" },
    },
  ],
  activeStates: [
    ...snapshot.activeStates,
    { ...learnedTokenState, versionId: "learning_tokens_incompatible" },
  ],
} as never as AxisLearningSnapshot;
const manualConflictSnapshot = {
  ...snapshot,
  versions: [
    ...snapshot.versions,
    {
      ...snapshot.versions[0],
      id: "learning_override_manual",
      proposalId: "proposal_override_manual",
      change: {
        op: "set-rule",
        rule: {
          ...manualPreferenceRule,
          origin: "learning",
          text: "Learned default.",
          effect: "default",
          defaultValue: "learned",
        },
      },
    },
    {
      ...snapshot.versions[0],
      id: "learning_remove_manual",
      proposalId: "proposal_remove_manual",
      change: { op: "remove-rule", ruleId: "precedence" },
    },
  ],
  activeStates: [
    ...snapshot.activeStates,
    { ...snapshot.activeStates[0], versionId: "learning_override_manual" },
    { ...snapshot.activeStates[0], versionId: "learning_remove_manual" },
  ],
} as never as AxisLearningSnapshot;
const instructionVersion = snapshot.versions.find(
  (version) => version.id === "learning_instruction",
)!;
const instructionState = snapshot.activeStates.find(
  (state) => state.versionId === "learning_instruction",
)!;
const invalidInstructionSnapshot = {
  ...snapshot,
  versions: [
    ...snapshot.versions,
    {
      ...instructionVersion,
      id: "learning_unknown_capability",
      proposalId: "proposal_unknown_capability",
      change: { ...instructionVersion.change, capabilityId: "unknown-capability" },
    },
    {
      ...instructionVersion,
      id: "learning_disabled_capability",
      proposalId: "proposal_disabled_capability",
      change: { ...instructionVersion.change, capabilityId: "disabled-capability" },
    },
    {
      ...instructionVersion,
      id: "learning_other_provider_capability",
      proposalId: "proposal_other_provider_capability",
      change: { ...instructionVersion.change, capabilityId: "other-provider-capability" },
    },
  ],
  activeStates: [
    ...snapshot.activeStates,
    { ...instructionState, versionId: "learning_unknown_capability" },
    { ...instructionState, versionId: "learning_disabled_capability" },
    { ...instructionState, versionId: "learning_other_provider_capability" },
  ],
} as never as AxisLearningSnapshot;
const noLearningSnapshot = {
  ...snapshot,
  versions: [],
  activeStates: [],
} as never as AxisLearningSnapshot;
profileByProject.set("manual-conflict", {
  ...profile,
  scope: makeScope("manual-conflict"),
  rules: [manualPreferenceRule],
} as never);
const snapshotByProject = new Map<string, AxisLearningSnapshot>([
  ["manifest-first", relaxationSnapshot],
  ["manual-first", relaxationSnapshot],
  ["incompatible-model", incompatibleModelSnapshot],
  ["manual-conflict", manualConflictSnapshot],
  ["invalid-capabilities", invalidInstructionSnapshot],
  ["token-order", noLearningSnapshot],
]);
const catalog = {
  contexts: [],
  projectBindings: [],
  providerOwnerships: [{ contextId: "company", provider }],
  providerAccessGrants: [],
  capabilities: [
    {
      id: "capability",
      provider,
      kind: "skill",
      name: "Skill",
      enabled: true,
      compatibleDrivers: [],
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:00:00.000Z",
    },
    {
      id: "disabled-capability",
      provider,
      kind: "skill",
      name: "Disabled skill",
      enabled: false,
      compatibleDrivers: [],
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:00:00.000Z",
    },
    {
      id: "other-provider-capability",
      provider: otherProvider,
      kind: "skill",
      name: "Other provider skill",
      enabled: true,
      compatibleDrivers: [],
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:00:00.000Z",
    },
    {
      id: "incompatible-driver-capability",
      provider,
      kind: "skill",
      name: "Incompatible driver skill",
      enabled: true,
      compatibleDrivers: ["claudeAgent"],
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:00:00.000Z",
    },
  ],
  workHubSources: [],
} as never;

const dependencies = Layer.mergeAll(
  Layer.succeed(AxisProjectScope, {
    resolve: (request: {
      provider: { environmentId: string };
      scope: { project: { environmentId: string } };
    }) =>
      request.provider.environmentId === request.scope.project.environmentId
        ? Effect.succeed(request)
        : Effect.fail(
            new AxisProjectScopeResolutionError({
              reason: "provider_environment_mismatch",
              message: "The provider belongs to another project environment.",
            }),
          ),
    resolveProject: (request: unknown) => Effect.succeed(request),
  } as never),
  Layer.succeed(AxisProjectProfileStore, {
    get: (requestedScope) =>
      Effect.succeed(profileByProject.get(requestedScope.project.projectId) ?? profile),
    replace: () => Effect.die("unused"),
    resetOverride: () => Effect.die("unused"),
  }),
  Layer.succeed(AxisLearningStore, {
    getSnapshot: (_contextId: AxisLearningScope["contextId"], requestedScope?: AxisLearningScope) =>
      Effect.succeed(snapshotByProject.get(requestedScope?.project?.projectId ?? "") ?? snapshot),
  } as never),
  Layer.succeed(AxisContextCatalogStore, {
    get: Effect.succeed({ revision: 1, catalog, updatedAt: "2026-09-05T00:00:00.000Z" }),
  } as never),
);
const layer = it.layer(
  Layer.merge(
    Layer.effect(AxisEffectiveContext, make).pipe(Layer.provide(dependencies)),
    dependencies,
  ),
);

layer("AxisEffectiveContext", (it) => {
  it.effect("resolves deterministically and merges persisted and active learning", () =>
    Effect.gen(function* () {
      const resolver = yield* AxisEffectiveContext;
      const input = { scope, provider, model: "gpt-5", step: "verify", paths: ["src/main.ts"] };
      const first = yield* resolver.resolve(withCaller(input));
      const second = yield* resolver.resolve(withCaller(input));
      assert.deepEqual(first, second);
      assert.equal(first.digest, second.digest);
      assert.deepEqual(
        first.rules.map((rule) => rule.id),
        ["lint", "policy"],
      );
      assert.equal(first.capabilities.length, 1);
      assert.deepEqual(
        first.workflow.map((step) => step.id),
        ["verify"],
      );
      assert.deepEqual(first.providerInstructions, [
        { capabilityId: AxisCapabilityId.make("capability"), instruction: "Use focused tests." },
      ]);
      assert.deepEqual(first.tokenEfficiencyPolicies, [
        {
          providerInstanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
          engine: "deterministic",
          mode: "record",
        },
      ]);
    }),
  );

  it.effect("keeps duplicate token policy digests stable when input policy order is reversed", () =>
    Effect.gen(function* () {
      const resolver = yield* AxisEffectiveContext;
      const input = { scope: tokenOrderScope, provider, step: "verify", paths: [] };
      const first = yield* resolver.resolve(withCaller(input));

      profileByProject.set("token-order", {
        ...profileByProject.get("token-order")!,
        tokenEfficiencyPolicies: tokenOrderPolicies.toReversed(),
      });
      const second = yield* resolver.resolve(withCaller(input));

      assert.equal(first.digest, second.digest);
      assert.deepEqual(
        second.tokenEfficiencyPolicies.map((policy) => policy.model),
        ["gpt-4", "gpt-5"],
      );
      assert.equal(
        second.tokenEfficiencyPolicies.find((policy) => policy.model === "gpt-5")?.mode,
        "compress",
      );
    }),
  );

  it.effect("does not include a learned token policy for another model", () =>
    Effect.gen(function* () {
      const resolver = yield* AxisEffectiveContext;
      const result = yield* resolver.resolve(
        withCaller({
          scope: makeScope("incompatible-model"),
          provider,
          model: "gpt-5",
          step: "verify",
          paths: [],
        }),
      );

      assert.deepEqual(
        result.tokenEfficiencyPolicies.map((policy) => policy.model),
        ["gpt-5"],
      );
      assert.deepEqual(result.tokenEfficiencyPolicy, { engine: "deterministic", mode: "record" });
    }),
  );

  it.effect("rejects a stale profile revision", () =>
    Effect.gen(function* () {
      const resolver = yield* AxisEffectiveContext;
      const error = yield* Effect.flip(
        resolver.resolve(
          withCaller({ scope, provider, step: "verify", paths: [], profileRevision: 3 }),
        ),
      );
      assert.equal(error._tag, "AxisEffectiveContextValidationError");
    }),
  );

  it.effect("uses stable manual precedence without relaxing restrictions", () =>
    Effect.gen(function* () {
      const resolver = yield* AxisEffectiveContext;
      const resolve = (projectId: string, paths: ReadonlyArray<string>) =>
        resolver.resolve(
          withCaller({ scope: makeScope(projectId), provider, step: "verify", paths }),
        );

      const manifestFirst = yield* resolve("manifest-first", ["src/main.ts"]);
      const manualFirst = yield* resolve("manual-first", ["src/main.ts"]);

      assert.deepEqual(manifestFirst.rules, manualFirst.rules);
      assert.equal(manifestFirst.rules.find((rule) => rule.id === "precedence")?.origin, "manual");
      assert.equal(
        manifestFirst.rules.find((rule) => rule.id === "precedence")?.text,
        "Manual preference.",
      );
      assert.equal(manifestFirst.rules.find((rule) => rule.id === "protected")?.origin, "manifest");
      assert.equal(
        manifestFirst.rules.find((rule) => rule.id === "protected")?.effect,
        "restriction",
      );
      assert.equal(
        manifestFirst.conflicts.includes("Learned change cannot relax restriction protected."),
        true,
      );

      const unrelatedPath = yield* resolve("manual-first", ["docs/readme.md"]);
      assert.deepEqual(unrelatedPath.rules, []);
      assert.deepEqual(unrelatedPath.sourceRefs, []);
    }),
  );

  it.effect("matches descendants of a rule path with a trailing slash", () =>
    Effect.gen(function* () {
      const resolver = yield* AxisEffectiveContext;
      const result = yield* resolver.resolve(
        withCaller({
          scope: makeScope("trailing-slash"),
          provider,
          step: "verify",
          paths: ["vinyl/components/file.ts"],
        }),
      );

      assert.deepEqual(
        result.rules.map((rule) => rule.id),
        ["policy"],
      );
    }),
  );

  it.effect("does not let learned rules replace or remove manual rules", () =>
    Effect.gen(function* () {
      const resolver = yield* AxisEffectiveContext;
      const result = yield* resolver.resolve(
        withCaller({
          scope: makeScope("manual-conflict"),
          provider,
          step: "verify",
          paths: ["src/main.ts"],
        }),
      );

      assert.equal(
        result.rules.find((rule) => rule.id === "precedence")?.text,
        "Manual preference.",
      );
      assert.equal(
        result.conflicts.includes("Learned change cannot override manual rule precedence."),
        true,
      );
      assert.equal(
        result.conflicts.includes("Learned change cannot remove manual rule precedence."),
        true,
      );
    }),
  );

  it.effect(
    "rejects learned instructions for unknown, disabled, or other-provider capabilities",
    () =>
      Effect.gen(function* () {
        const resolver = yield* AxisEffectiveContext;
        const result = yield* resolver.resolve(
          withCaller({
            scope: makeScope("invalid-capabilities"),
            provider,
            step: "verify",
            paths: [],
          }),
        );

        assert.deepEqual(result.providerInstructions, [
          { capabilityId: AxisCapabilityId.make("capability"), instruction: "Use focused tests." },
        ]);
        assert.equal(result.capabilities.length, 1);
        assert.equal(
          result.capabilities.some(
            (capability) => capability.id === "incompatible-driver-capability",
          ),
          false,
        );
        assert.equal(result.conflicts.length, 3);
        assert.equal(
          result.conflicts.some((conflict) => conflict.includes("unknown-capability")),
          true,
        );
        assert.equal(
          result.conflicts.some((conflict) => conflict.includes("disabled-capability")),
          true,
        );
        assert.equal(
          result.conflicts.some((conflict) => conflict.includes("other-provider-capability")),
          true,
        );
      }),
  );

  it.effect("rejects providers from another project environment", () =>
    Effect.gen(function* () {
      const resolver = yield* AxisEffectiveContext;
      const error = yield* Effect.flip(
        resolver.resolve(
          withCaller({
            scope,
            provider: { environmentId: "other-env", instanceId: "codex" } as never,
            step: "verify",
            paths: [],
          }),
        ),
      );

      assert.equal(error._tag, "AxisEffectiveContextValidationError");
      assert.equal(error.message, "The provider belongs to another project environment.");
    }),
  );
});

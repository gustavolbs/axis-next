import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  AxisContextProjectScope,
  AxisProjectRule,
  AxisProjectRuleId,
  AxisProjectTokenEfficiencyPolicy,
  AxisTypedChange,
} from "../../../../../packages/contracts/src/axisProjectProfile.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  AxisProjectProfileConflictError,
  AxisProjectProfileValidationError,
  AxisProjectProfileStore,
  layer as storeLayer,
} from "./AxisProjectProfileStore.ts";

const testLayer = Layer.merge(
  SqlitePersistenceMemory,
  storeLayer.pipe(Layer.provide(SqlitePersistenceMemory)),
);
const layer = it.layer(testLayer);
const decodeScope = Schema.decodeUnknownSync(AxisContextProjectScope);
const decodeRule = Schema.decodeUnknownSync(AxisProjectRule);
const decodeChange = Schema.decodeUnknownSync(AxisTypedChange);
const decodeTokenEfficiencyPolicy = Schema.decodeUnknownSync(AxisProjectTokenEfficiencyPolicy);

const scopeA = decodeScope({
  contextId: "company_a",
  project: { environmentId: "laptop", projectId: "project-a" },
});
const resetScope = decodeScope({
  contextId: "company_a_reset",
  project: { environmentId: "laptop", projectId: "project-a" },
});
const isolatedScopeA = decodeScope({
  contextId: "company_a_isolated",
  project: { environmentId: "laptop", projectId: "project-a" },
});
const isolatedScopeB = decodeScope({
  contextId: "company_a_isolated",
  project: { environmentId: "desktop", projectId: "project-a" },
});

const rule = (origin: "manifest" | "manual", text: string) =>
  decodeRule({
    id: "company-policy",
    category: "test-policy",
    text,
    origin,
    sourceRef: "company-policy-source",
    sourceRevision: 1,
    paths: [],
    strength: "explicit",
    effect: "restriction",
    restriction: "Keep the focused test policy.",
    defaultValue: null,
    condition: null,
  });

layer("AxisProjectProfileStore", (it) => {
  it.effect("writes with optimistic concurrency and reports the current revision", () =>
    Effect.gen(function* () {
      const store = yield* AxisProjectProfileStore;
      const initial = yield* store.get(scopeA);
      const firstChange = decodeChange({ op: "set-rule", rule: rule("manifest", "Run tests.") });

      const updated = yield* store.replace(scopeA, initial.revision, [firstChange]);
      assert.equal(updated.revision, 1);
      const conflict = yield* store.replace(scopeA, 0, []).pipe(Effect.flip);

      assert.instanceOf(conflict, AxisProjectProfileConflictError);
      assert.equal(conflict.actualRevision, 1);
      assert.equal((yield* store.get(scopeA)).revision, 1);
    }),
  );

  it.effect("resets only the manual override and preserves the business-origin rule", () =>
    Effect.gen(function* () {
      const store = yield* AxisProjectProfileStore;
      const businessRule = rule("manifest", "Company policy.");
      const overrideRule = rule("manual", "Local adjustment.");
      const seeded = yield* store.replace(resetScope, 0, [
        decodeChange({ op: "set-rule", rule: businessRule }),
        decodeChange({ op: "set-rule", rule: overrideRule }),
      ]);
      const updatedOverride = { ...overrideRule, text: "Updated local adjustment." };
      const updated = yield* store.replace(resetScope, seeded.revision, [
        decodeChange({ op: "set-rule", rule: updatedOverride }),
      ]);

      assert.deepEqual(updated.rules, [businessRule, updatedOverride]);

      const reset = yield* store.resetOverride(
        resetScope,
        AxisProjectRuleId.make("company-policy"),
        updated.revision,
      );

      assert.deepEqual(reset.rules, [businessRule]);
      assert.equal(reset.revision, updated.revision + 1);
    }),
  );

  it.effect("isolates physical projects and contexts through the persisted scope", () =>
    Effect.gen(function* () {
      const store = yield* AxisProjectProfileStore;
      const profileA = yield* store.replace(isolatedScopeA, 0, [
        decodeChange({ op: "set-rule", rule: rule("manifest", "Only laptop.") }),
      ]);
      const profileB = yield* store.replace(isolatedScopeB, 0, [
        decodeChange({ op: "set-rule", rule: rule("manifest", "Only desktop.") }),
      ]);

      assert.equal((yield* store.get(isolatedScopeA)).rules[0]?.text, "Only laptop.");
      assert.equal((yield* store.get(isolatedScopeB)).rules[0]?.text, "Only desktop.");
      assert.equal(profileA.revision, 1);
      assert.equal(profileB.revision, 1);
    }),
  );

  it.effect("persists and replaces token-efficiency policies in the profile", () =>
    Effect.gen(function* () {
      const store = yield* AxisProjectProfileStore;
      const policyScope = decodeScope({
        contextId: "company_a_policy",
        project: { environmentId: "laptop", projectId: "project-a" },
      });
      const initial = yield* store.get(policyScope);
      const compress = decodeChange({
        op: "set-token-efficiency-policy",
        providerInstanceId: "codex",
        model: "gpt-5",
        engine: "deterministic",
        mode: "compress",
      });

      const updated = yield* store.replace(policyScope, initial.revision, [compress]);
      const expectedPolicy = decodeTokenEfficiencyPolicy({
        providerInstanceId: "codex",
        model: "gpt-5",
        engine: "deterministic",
        mode: "compress",
      });
      assert.deepEqual(updated.tokenEfficiencyPolicies, [expectedPolicy]);
      assert.deepEqual((yield* store.get(policyScope)).tokenEfficiencyPolicies, [expectedPolicy]);

      const record = decodeChange({ ...compress, mode: "record" });
      const replaced = yield* store.replace(policyScope, updated.revision, [record]);
      assert.deepEqual(replaced.tokenEfficiencyPolicies, [{ ...expectedPolicy, mode: "record" }]);
    }),
  );

  it.effect("keeps validation failures distinct from persistence failures", () =>
    Effect.gen(function* () {
      const store = yield* AxisProjectProfileStore;
      const validationScope = decodeScope({
        contextId: "company_a_validation",
        project: { environmentId: "laptop", projectId: "project-a" },
      });
      const invalidChange = decodeChange({
        op: "set-provider-instruction",
        capabilityId: "provider-instruction",
        instruction: "Provider-owned text cannot be persisted in this profile.",
      });

      const error = yield* Effect.flip(store.replace(validationScope, 0, [invalidChange]));
      assert.instanceOf(error, AxisProjectProfileValidationError);
      assert.equal((yield* store.get(validationScope)).revision, 0);
    }),
  );
});

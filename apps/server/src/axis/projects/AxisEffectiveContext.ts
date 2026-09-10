import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";

import {
  AxisContextProjectScope,
  AxisLearningSnapshot,
  AxisProjectProfile,
  type AxisCapabilityId,
  type AxisProjectWorkflowStep,
  AxisProviderInstanceLocator,
  AxisTypedChange,
  TokenEfficiencyEngineId,
  resolveAxisContextCapabilities,
  type ProviderDriverKind,
  type AxisCapability as AxisCapabilityType,
  type AxisLearningVersionId,
  type AxisProjectRule as AxisProjectRuleType,
} from "@t3tools/contracts";
import { AxisContextCatalogStore } from "../contexts/AxisContextCatalogStore.ts";
import { AxisLearningStore } from "../learning/AxisLearningStore.ts";
import { AxisProjectProfileStore } from "./AxisProjectProfileStore.ts";
import { AxisProjectScope, AxisProjectScopeResolutionError } from "./AxisProjectScope.ts";

const isAxisTypedChange = Schema.is(AxisTypedChange);

export interface AxisEffectiveContextInput {
  readonly caller: {
    readonly environmentId: AxisContextProjectScope["project"]["environmentId"];
    readonly contextId: AxisContextProjectScope["contextId"];
  };
  readonly scope: AxisContextProjectScope;
  readonly provider: AxisProviderInstanceLocator;
  readonly driver: ProviderDriverKind;
  readonly model?: string;
  readonly step: string;
  readonly paths: ReadonlyArray<string>;
  readonly profileRevision?: number;
}

export interface AxisEffectiveContextResult {
  readonly scope: AxisContextProjectScope;
  readonly provider: AxisProviderInstanceLocator;
  readonly model?: string;
  readonly step: string;
  readonly profileRevision: number;
  readonly rules: ReadonlyArray<AxisProjectRuleType>;
  readonly workflow: ReadonlyArray<AxisProjectWorkflowStep>;
  readonly providerInstructions: ReadonlyArray<{
    readonly capabilityId: AxisCapabilityId;
    readonly instruction: string;
  }>;
  readonly tokenEfficiencyPolicies: ReadonlyArray<{
    readonly providerInstanceId: AxisProviderInstanceLocator["instanceId"];
    readonly model: string;
    readonly engine: string;
    readonly mode: "off" | "record" | "compress";
  }>;
  readonly tokenEfficiencyPolicy?: {
    readonly engine: TokenEfficiencyEngineId;
    readonly mode: "off" | "record" | "compress";
  };
  readonly sourceRefs: ReadonlyArray<string>;
  readonly capabilities: ReadonlyArray<AxisCapabilityType>;
  readonly conflicts: ReadonlyArray<string>;
  readonly learningVersionIds: ReadonlyArray<AxisLearningVersionId>;
  readonly digest: string;
}

export class AxisEffectiveContextValidationError extends Schema.TaggedErrorClass<AxisEffectiveContextValidationError>()(
  "AxisEffectiveContextValidationError",
  { message: Schema.String },
) {}

const normalizeRelativePath = (path: string) =>
  path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");

const pathApplies = (rule: AxisProjectRuleType, requestedPaths: ReadonlyArray<string>) => {
  if (rule.paths.length === 0 || requestedPaths.length === 0) return true;
  return rule.paths.some((rulePath) => {
    const normalizedRulePath = normalizeRelativePath(rulePath);
    return requestedPaths.some((path) => {
      const normalizedPath = normalizeRelativePath(path);
      return (
        normalizedPath === normalizedRulePath ||
        normalizedPath.startsWith(`${normalizedRulePath}/`) ||
        normalizedRulePath.startsWith(`${normalizedPath}/`)
      );
    });
  });
};

const ruleEffectPrecedence: Readonly<Record<AxisProjectRuleType["effect"], number>> = {
  default: 0,
  preference: 1,
  restriction: 2,
};

const ruleOriginPrecedence: Readonly<Record<AxisProjectRuleType["origin"], number>> = {
  inherited: 0,
  convention: 1,
  template: 2,
  ci: 3,
  instruction: 4,
  manifest: 5,
  manual: 6,
  learning: 7,
};

const ruleTieBreakKey = (rule: AxisProjectRuleType) =>
  JSON.stringify({
    category: rule.category,
    text: rule.text,
    sourceRef: rule.sourceRef,
    sourceRevision: rule.sourceRevision,
    paths: [...rule.paths].sort(),
    strength: rule.strength,
    effect: rule.effect,
    restriction: rule.restriction,
    defaultValue: rule.defaultValue,
    condition: rule.condition,
  });

const compareRulePrecedence = (left: AxisProjectRuleType, right: AxisProjectRuleType) =>
  ruleEffectPrecedence[left.effect] - ruleEffectPrecedence[right.effect] ||
  ruleOriginPrecedence[left.origin] - ruleOriginPrecedence[right.origin] ||
  ruleTieBreakKey(left).localeCompare(ruleTieBreakKey(right));

type TokenEfficiencyPolicy = {
  readonly providerInstanceId: AxisProviderInstanceLocator["instanceId"];
  readonly model: string;
  readonly engine: TokenEfficiencyEngineId;
  readonly mode: "off" | "record" | "compress";
};

const tokenEfficiencyPolicyKey = (policy: TokenEfficiencyPolicy) =>
  JSON.stringify({
    providerInstanceId: policy.providerInstanceId,
    model: policy.model,
    engine: policy.engine,
    mode: policy.mode,
  });

const chooseTokenEfficiencyPolicy = (left: TokenEfficiencyPolicy, right: TokenEfficiencyPolicy) =>
  tokenEfficiencyPolicyKey(left).localeCompare(tokenEfficiencyPolicyKey(right)) <= 0 ? left : right;

const learningStateKey = (state: AxisLearningSnapshot["activeStates"][number]) =>
  `${state.targetKey}\u0000${state.versionId ?? ""}`;

const applyLearningChanges = (
  profile: AxisProjectProfile,
  snapshot: AxisLearningSnapshot,
  providerInstanceId: AxisProviderInstanceLocator["instanceId"],
  model: string | undefined,
  targetKey: string,
  paths: ReadonlyArray<string>,
  availableCapabilityIds: ReadonlySet<AxisCapabilityId>,
) => {
  const rules = new Map<string, AxisProjectRuleType>();
  const manualRuleIds = new Set(
    profile.rules.filter((rule) => rule.origin === "manual").map((rule) => rule.id),
  );
  for (const rule of profile.rules) {
    const previous = rules.get(rule.id);
    if (previous === undefined || compareRulePrecedence(rule, previous) > 0) {
      rules.set(rule.id, rule);
    }
  }
  const workflow = new Map(profile.workflow.map((step) => [step.id, step]));
  const providerInstructions = new Map<AxisCapabilityId, string>();
  const tokenEfficiencyPolicies = new Map<string, TokenEfficiencyPolicy>();
  for (const policy of (profile.tokenEfficiencyPolicies ?? []).filter(
    (candidate) =>
      candidate.providerInstanceId === providerInstanceId &&
      (model === undefined || candidate.model === model),
  )) {
    const key = `${policy.providerInstanceId}:${policy.model}`;
    const previous = tokenEfficiencyPolicies.get(key);
    tokenEfficiencyPolicies.set(
      key,
      previous === undefined ? policy : chooseTokenEfficiencyPolicy(previous, policy),
    );
  }
  const learnedTokenEfficiencyPolicyKeys = new Set<string>();
  const sourceRefs = new Set(profile.rules.map((rule) => rule.sourceRef));
  const conflicts: Array<string> = [];
  const learningVersionIds: Array<AxisLearningVersionId> = [];

  for (const state of snapshot.activeStates.toSorted((left, right) =>
    learningStateKey(left).localeCompare(learningStateKey(right)),
  )) {
    if (state.targetKey !== targetKey || state.versionId === null) continue;
    const version = snapshot.versions.find((candidate) => candidate.id === state.versionId);
    if (version === undefined || !isAxisTypedChange(version.change)) continue;
    const change = version.change;
    if (change.op === "set-rule") {
      const previous = rules.get(change.rule.id);
      if (
        previous?.effect === "restriction" &&
        (change.rule.effect !== "restriction" || change.rule.restriction === null)
      ) {
        conflicts.push(`Learned change cannot relax restriction ${change.rule.id}.`);
        continue;
      }
      if (manualRuleIds.has(change.rule.id)) {
        conflicts.push(`Learned change cannot override manual rule ${change.rule.id}.`);
        continue;
      }
      rules.set(change.rule.id, change.rule);
      sourceRefs.add(change.rule.sourceRef);
      learningVersionIds.push(version.id);
    } else if (change.op === "remove-rule") {
      const previous = rules.get(change.ruleId);
      if (previous?.effect === "restriction") {
        conflicts.push(`Learned change cannot remove restriction ${change.ruleId}.`);
      } else if (manualRuleIds.has(change.ruleId)) {
        conflicts.push(`Learned change cannot remove manual rule ${change.ruleId}.`);
      } else {
        rules.delete(change.ruleId);
        learningVersionIds.push(version.id);
      }
    } else if (change.op === "set-workflow-step") {
      const previous = workflow.get(change.step.id);
      if (previous?.required === true && change.step.required === false) {
        conflicts.push(`Learned change cannot relax required workflow step ${change.step.id}.`);
      } else {
        workflow.set(change.step.id, change.step);
        learningVersionIds.push(version.id);
      }
    } else if (change.op === "set-provider-instruction") {
      if (!availableCapabilityIds.has(change.capabilityId)) {
        conflicts.push(
          `Learned provider instruction targets unavailable capability ${change.capabilityId}.`,
        );
        continue;
      }
      providerInstructions.set(change.capabilityId, change.instruction);
      learningVersionIds.push(version.id);
    } else if (change.op === "set-token-efficiency-policy") {
      if (change.providerInstanceId !== providerInstanceId) {
        conflicts.push(`Learned token policy targets another provider instance.`);
      } else if (model !== undefined && change.model !== model) {
        continue;
      } else {
        const key = `${change.providerInstanceId}:${change.model}`;
        const learnedPolicy: TokenEfficiencyPolicy = {
          providerInstanceId: change.providerInstanceId,
          model: change.model,
          engine: change.engine,
          mode: change.mode,
        };
        const previous = tokenEfficiencyPolicies.get(key);
        tokenEfficiencyPolicies.set(
          key,
          !learnedTokenEfficiencyPolicyKeys.has(key) || previous === undefined
            ? learnedPolicy
            : chooseTokenEfficiencyPolicy(previous, learnedPolicy),
        );
        learnedTokenEfficiencyPolicyKeys.add(key);
        learningVersionIds.push(version.id);
      }
    }
  }

  const filteredRules = [...rules.values()]
    .filter((rule) => pathApplies(rule, paths))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    rules: filteredRules,
    workflow: [...workflow.values()].sort(
      (left, right) => left.order - right.order || left.id.localeCompare(right.id),
    ),
    providerInstructions: [...providerInstructions.entries()]
      .map(([capabilityId, instruction]) => ({ capabilityId, instruction }))
      .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId)),
    tokenEfficiencyPolicies: [...tokenEfficiencyPolicies.values()].sort(
      (left, right) =>
        left.providerInstanceId.localeCompare(right.providerInstanceId) ||
        left.model.localeCompare(right.model),
    ),
    sourceRefs: [...sourceRefs].sort(),
    conflicts,
    learningVersionIds: learningVersionIds.sort(),
  };
};

const digest = (input: Omit<AxisEffectiveContextResult, "digest">) =>
  `sha256:${NodeCrypto.createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex")}`;

export class AxisEffectiveContext extends Context.Service<
  AxisEffectiveContext,
  {
    readonly resolve: (
      input: AxisEffectiveContextInput,
    ) => Effect.Effect<AxisEffectiveContextResult, AxisEffectiveContextValidationError>;
  }
>()("t3/axis/projects/AxisEffectiveContext") {}

export const make = Effect.gen(function* () {
  const profiles = yield* AxisProjectProfileStore;
  const learning = yield* AxisLearningStore;
  const catalogs = yield* AxisContextCatalogStore;
  const projectScope = yield* AxisProjectScope;

  const resolve: AxisEffectiveContext["Service"]["resolve"] = (input) =>
    Effect.gen(function* () {
      yield* projectScope
        .resolve({
          caller: input.caller,
          operation: "execute",
          scope: input.scope,
          provider: input.provider,
        })
        .pipe(
          Effect.mapError(
            (error: AxisProjectScopeResolutionError) =>
              new AxisEffectiveContextValidationError({ message: error.message }),
          ),
        );
      const profile = yield* profiles.get(input.scope).pipe(
        Effect.mapError(
          () =>
            new AxisEffectiveContextValidationError({
              message: "Project profile could not be read.",
            }),
        ),
      );
      if (input.profileRevision !== undefined && input.profileRevision !== profile.revision) {
        return yield* new AxisEffectiveContextValidationError({
          message: `Profile revision ${input.profileRevision} is stale; current revision is ${profile.revision}.`,
        });
      }
      const snapshot = yield* learning.getSnapshot(input.scope.contextId, input.scope).pipe(
        Effect.mapError(
          () =>
            new AxisEffectiveContextValidationError({
              message: "Learning snapshot could not be read.",
            }),
        ),
      );
      const catalog = yield* catalogs.get.pipe(
        Effect.mapError(
          () =>
            new AxisEffectiveContextValidationError({
              message: "Axis context catalog could not be read.",
            }),
        ),
      );
      const capabilities = [
        ...resolveAxisContextCapabilities({
          catalog: catalog.catalog,
          contextId: input.scope.contextId,
          provider: input.provider,
          driver: input.driver,
        }),
      ].sort((left, right) => left.id.localeCompare(right.id));
      const merged = applyLearningChanges(
        profile,
        snapshot,
        input.provider.instanceId,
        input.model,
        `provider:${input.provider.instanceId}:step:${input.step}`,
        input.paths,
        new Set(capabilities.map((capability) => capability.id)),
      );
      const selectedTokenEfficiencyPolicy = merged.tokenEfficiencyPolicies.find(
        (policy) => policy.model === input.model,
      );
      const resultWithoutDigest = {
        scope: input.scope,
        provider: input.provider,
        ...(input.model === undefined ? {} : { model: input.model }),
        step: input.step,
        profileRevision: profile.revision,
        rules: merged.rules,
        workflow: merged.workflow,
        providerInstructions: merged.providerInstructions,
        tokenEfficiencyPolicies: merged.tokenEfficiencyPolicies,
        ...(selectedTokenEfficiencyPolicy === undefined
          ? {}
          : {
              tokenEfficiencyPolicy: {
                engine: TokenEfficiencyEngineId.make(selectedTokenEfficiencyPolicy.engine),
                mode: selectedTokenEfficiencyPolicy.mode,
              },
            }),
        sourceRefs: merged.sourceRefs,
        capabilities,
        conflicts: merged.conflicts,
        learningVersionIds: merged.learningVersionIds,
      } satisfies Omit<AxisEffectiveContextResult, "digest">;
      return { ...resultWithoutDigest, digest: digest(resultWithoutDigest) };
    });

  return { resolve } satisfies AxisEffectiveContext["Service"];
});

export const layer = Layer.effect(AxisEffectiveContext, make);

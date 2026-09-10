/** Versioned project profile contracts used by Axis onboarding and execution. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AxisCapabilityId, AxisContextId, AxisProjectLocator } from "./axisContext.ts";
import { TokenEfficiencyEngineId, TokenEfficiencyMode } from "./tokenEfficiency.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

const profileId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  ).pipe(Schema.brand(brand));

export const AxisProjectProfileSourceId = profileId("AxisProjectProfileSourceId");
export type AxisProjectProfileSourceId = typeof AxisProjectProfileSourceId.Type;

export const AxisProjectRuleId = profileId("AxisProjectRuleId");
export type AxisProjectRuleId = typeof AxisProjectRuleId.Type;

export const AxisWorkflowStepId = profileId("AxisWorkflowStepId");
export type AxisWorkflowStepId = typeof AxisWorkflowStepId.Type;

/** The physical project scope used by all project-owned Axis records. */
export const AxisContextProjectScope = Schema.Struct({
  contextId: AxisContextId,
  project: AxisProjectLocator,
});
export type AxisContextProjectScope = typeof AxisContextProjectScope.Type;

/** Source material is referenced by rules and facts without copying its contents. */
export const AxisProjectProfileSource = Schema.Struct({
  id: AxisProjectProfileSourceId,
  kind: Schema.Literals(["manifest", "instruction", "ci", "template", "convention", "manual"]),
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  digest: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  observedAt: IsoDateTime,
});
export type AxisProjectProfileSource = typeof AxisProjectProfileSource.Type;

const scriptName = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const sourceRef = AxisProjectProfileSourceId;

export const AxisProjectScriptFact = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("script"),
    name: scriptName,
    status: Schema.Literal("present"),
    command: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
    sourceRef,
  }),
  Schema.Struct({
    kind: Schema.Literal("script"),
    name: scriptName,
    status: Schema.Literal("absent"),
    sourceRef,
  }),
  Schema.Struct({
    kind: Schema.Literal("script"),
    name: scriptName,
    status: Schema.Literal("unreadable"),
    sourceRef,
    error: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  }),
]);
export type AxisProjectScriptFact = typeof AxisProjectScriptFact.Type;

export const AxisProjectFact = Schema.Union([
  AxisProjectScriptFact,
  Schema.Struct({
    kind: Schema.Literal("value"),
    key: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    value: TrimmedString.check(Schema.isMaxLength(2_000)),
    sourceRef,
  }),
]);
export type AxisProjectFact = typeof AxisProjectFact.Type;

export const AxisProjectRuleCategory = Schema.Literals([
  "tool",
  "command",
  "convention",
  "test-policy",
  "pull-request-policy",
  "path",
  "instruction",
]);
export type AxisProjectRuleCategory = typeof AxisProjectRuleCategory.Type;

export const AxisProjectRuleOrigin = Schema.Literals([
  "manifest",
  "instruction",
  "ci",
  "template",
  "convention",
  "manual",
  "learning",
  "inherited",
]);
export type AxisProjectRuleOrigin = typeof AxisProjectRuleOrigin.Type;

export const AxisProjectRuleStrength = Schema.Literals(["explicit", "inferred", "default"]);
export type AxisProjectRuleStrength = typeof AxisProjectRuleStrength.Type;

/** A rule keeps restriction/default semantics explicit instead of using JSON. */
export const AxisProjectRule = Schema.Struct({
  id: AxisProjectRuleId,
  category: AxisProjectRuleCategory,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  origin: AxisProjectRuleOrigin,
  sourceRef,
  sourceRevision: NonNegativeInt,
  paths: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(512))).check(
    Schema.isMaxLength(100),
  ),
  strength: AxisProjectRuleStrength,
  effect: Schema.Literals(["restriction", "preference", "default"]),
  restriction: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
  defaultValue: Schema.NullOr(TrimmedString.check(Schema.isMaxLength(2_000))),
  condition: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
});
export type AxisProjectRule = typeof AxisProjectRule.Type;

export const AxisProjectManualDecision = Schema.Struct({
  id: profileId("AxisProjectManualDecisionId"),
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  decision: Schema.Literals(["accept", "reject", "defer"]),
  note: Schema.NullOr(TrimmedString.check(Schema.isMaxLength(4_000))),
  decidedAt: IsoDateTime,
});
export type AxisProjectManualDecision = typeof AxisProjectManualDecision.Type;

export const AxisProjectWorkflowStep = Schema.Struct({
  id: AxisWorkflowStepId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  instruction: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  required: Schema.Boolean,
  order: NonNegativeInt,
});
export type AxisProjectWorkflowStep = typeof AxisProjectWorkflowStep.Type;

/** Provider-local token-efficiency policy persisted with the project profile. */
export const AxisProjectTokenEfficiencyPolicy = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  engine: TokenEfficiencyEngineId,
  mode: TokenEfficiencyMode,
});
export type AxisProjectTokenEfficiencyPolicy = typeof AxisProjectTokenEfficiencyPolicy.Type;

export const AxisProjectProfile = Schema.Struct({
  scope: AxisContextProjectScope,
  revision: NonNegativeInt,
  sources: Schema.Array(AxisProjectProfileSource).check(Schema.isMaxLength(200)),
  facts: Schema.Array(AxisProjectFact).check(Schema.isMaxLength(500)),
  rules: Schema.Array(AxisProjectRule).check(Schema.isMaxLength(500)),
  manualDecisions: Schema.Array(AxisProjectManualDecision).check(Schema.isMaxLength(200)),
  workflow: Schema.Array(AxisProjectWorkflowStep).check(Schema.isMaxLength(100)),
  tokenEfficiencyPolicies: Schema.Array(AxisProjectTokenEfficiencyPolicy).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  updatedAt: IsoDateTime,
});
export type AxisProjectProfile = typeof AxisProjectProfile.Type;

export const AxisProjectRuleSet = Schema.Struct({
  scope: AxisContextProjectScope,
  source: AxisProjectProfileSourceId,
  revision: NonNegativeInt,
  rules: Schema.Array(AxisProjectRule).check(Schema.isMaxLength(500)),
});
export type AxisProjectRuleSet = typeof AxisProjectRuleSet.Type;

export const AxisTypedChange = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("set-rule"),
    rule: AxisProjectRule,
  }),
  Schema.Struct({
    op: Schema.Literal("remove-rule"),
    ruleId: AxisProjectRuleId,
  }),
  Schema.Struct({
    op: Schema.Literal("set-workflow-step"),
    step: AxisProjectWorkflowStep,
  }),
  Schema.Struct({
    op: Schema.Literal("set-provider-instruction"),
    capabilityId: AxisCapabilityId,
    instruction: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  }),
  Schema.Struct({
    op: Schema.Literal("set-token-efficiency-policy"),
    providerInstanceId: ProviderInstanceId,
    model: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    engine: TokenEfficiencyEngineId,
    mode: TokenEfficiencyMode,
  }),
]);
export type AxisTypedChange = typeof AxisTypedChange.Type;

export const AxisProjectProfileReplaceInput = Schema.Struct({
  scope: AxisContextProjectScope,
  expectedRevision: NonNegativeInt,
  changes: Schema.Array(AxisTypedChange).check(Schema.isMaxLength(500)),
});
export type AxisProjectProfileReplaceInput = typeof AxisProjectProfileReplaceInput.Type;

export const AxisProjectProfileGetInput = Schema.Struct({
  scope: AxisContextProjectScope,
});
export type AxisProjectProfileGetInput = typeof AxisProjectProfileGetInput.Type;

export const AxisProjectProfileResetOverrideInput = Schema.Struct({
  scope: AxisContextProjectScope,
  ruleId: AxisProjectRuleId,
  expectedRevision: NonNegativeInt,
});
export type AxisProjectProfileResetOverrideInput = typeof AxisProjectProfileResetOverrideInput.Type;

export class AxisProjectProfileNotFoundError extends Schema.TaggedErrorClass<AxisProjectProfileNotFoundError>()(
  "AxisProjectProfileNotFoundError",
  { scope: AxisContextProjectScope },
) {}

export class AxisProjectProfileConflictError extends Schema.TaggedErrorClass<AxisProjectProfileConflictError>()(
  "AxisProjectProfileConflictError",
  {
    scope: AxisContextProjectScope,
    expectedRevision: NonNegativeInt,
    actualRevision: NonNegativeInt,
  },
) {}

export class AxisProjectProfileValidationError extends Schema.TaggedErrorClass<AxisProjectProfileValidationError>()(
  "AxisProjectProfileValidationError",
  { message: Schema.String },
) {}

export class AxisProjectProfilePersistenceError extends Schema.TaggedErrorClass<AxisProjectProfilePersistenceError>()(
  "AxisProjectProfilePersistenceError",
  { operation: Schema.String },
) {}

export const AxisProjectProfileError = Schema.Union([
  AxisProjectProfileNotFoundError,
  AxisProjectProfileConflictError,
  AxisProjectProfileValidationError,
  AxisProjectProfilePersistenceError,
]);
export type AxisProjectProfileError = typeof AxisProjectProfileError.Type;

/** Stable key for the physical project tuple. Presentation keys are excluded. */
export function axisProjectScopeKey(project: AxisProjectLocator): string {
  return `project:${JSON.stringify([project.environmentId, project.projectId])}`;
}

/** Stable key for a policy scope, qualified by its Axis context. */
export function axisContextProjectScopeKey(scope: AxisContextProjectScope): string {
  return `${scope.contextId}\u0000${axisProjectScopeKey(scope.project)}`;
}

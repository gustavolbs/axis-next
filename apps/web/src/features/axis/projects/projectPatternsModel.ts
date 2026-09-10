import type {
  AxisContextProjectScope,
  AxisProjectProfile,
  AxisProjectProfileReplaceInput,
  AxisProjectProfileResetOverrideInput,
  AxisProjectRule,
  AxisTypedChange,
} from "@t3tools/contracts";

export type AxisProjectPatternEntry = {
  readonly id: AxisProjectRule["id"];
  readonly effectiveRule: AxisProjectRule;
  readonly inheritedRule: AxisProjectRule | null;
  readonly override: AxisProjectRule | null;
  readonly origin: AxisProjectRule["origin"];
  readonly sourceRule: AxisProjectRule;
  readonly isInherited: boolean;
  readonly isOverridden: boolean;
  readonly restrictionLocked: boolean;
  readonly invalidRestrictionOverride: boolean;
};

export type AxisProjectPatternsModel = {
  readonly scope: AxisContextProjectScope;
  readonly revision: AxisProjectProfile["revision"];
  readonly sources: AxisProjectProfile["sources"];
  readonly rules: ReadonlyArray<AxisProjectPatternEntry>;
};

export type AxisProjectPatternsInput = {
  readonly profile: AxisProjectProfile;
  /** Rules inherited from the context/provider layer, when that snapshot is available. */
  readonly inheritedRules?: ReadonlyArray<AxisProjectRule>;
  /** A resolver may provide effective rules; otherwise this model resolves them locally. */
  readonly effectiveRules?: ReadonlyArray<AxisProjectRule>;
};

export type AxisProjectPatternEditResult =
  | { readonly ok: true; readonly change: Extract<AxisTypedChange, { readonly op: "set-rule" }> }
  | {
      readonly ok: false;
      readonly code: "empty-text" | "inherited-restriction" | "unknown-rule";
      readonly message: string;
    };

const byId = (rules: ReadonlyArray<AxisProjectRule>): ReadonlyMap<string, AxisProjectRule> =>
  new Map(rules.map((rule) => [rule.id, rule]));

const sameRestriction = (left: AxisProjectRule, right: AxisProjectRule): boolean =>
  left.effect === right.effect && left.restriction === right.restriction;

const mergeRules = (
  ...groups: ReadonlyArray<ReadonlyArray<AxisProjectRule> | undefined>
): ReadonlyArray<AxisProjectRule> => {
  const merged = new Map<string, AxisProjectRule>();
  for (const group of groups) {
    for (const rule of group ?? []) {
      if (!merged.has(rule.id)) merged.set(rule.id, rule);
    }
  }
  return [...merged.values()];
};

/**
 * Builds the editor from one physical profile. Presentation grouping is not an
 * input here, so two members with the same logical project name cannot share a
 * profile accidentally.
 */
export function buildProjectPatternsModel(
  input: AxisProjectPatternsInput,
): AxisProjectPatternsModel {
  const localRules = input.profile.rules.filter((rule) => rule.origin !== "manual");
  const overrides = byId(input.profile.rules.filter((rule) => rule.origin === "manual"));
  const inherited = byId(
    input.inheritedRules ?? localRules.filter((rule) => rule.origin === "inherited"),
  );
  const effective = byId(input.effectiveRules ?? mergeRules(input.inheritedRules, localRules));
  const ids = mergeRules(input.effectiveRules, input.inheritedRules, input.profile.rules).map(
    (rule) => rule.id,
  );

  const rules = ids.flatMap((id): ReadonlyArray<AxisProjectPatternEntry> => {
    const override = overrides.get(id) ?? null;
    const inheritedRule = inherited.get(id) ?? null;
    const fallback = effective.get(id) ?? input.profile.rules.find((rule) => rule.id === id);
    if (fallback === undefined) return [];

    const restrictionLocked = inheritedRule?.effect === "restriction";
    const invalidRestrictionOverride =
      restrictionLocked &&
      override !== null &&
      (!sameRestriction(inheritedRule, override) || override.text !== inheritedRule.text);
    const effectiveRule =
      restrictionLocked && inheritedRule !== null
        ? inheritedRule
        : (override ?? effective.get(id) ?? fallback);
    const sourceRule = inheritedRule ?? fallback;

    return [
      {
        id: fallback.id,
        effectiveRule,
        inheritedRule,
        override,
        origin: override === null ? effectiveRule.origin : "manual",
        sourceRule,
        isInherited: inheritedRule !== null,
        isOverridden: override !== null,
        restrictionLocked,
        invalidRestrictionOverride,
      },
    ];
  });

  return {
    scope: input.profile.scope,
    revision: input.profile.revision,
    sources: input.profile.sources,
    rules,
  };
}

export function buildRuleOverrideChange(
  model: AxisProjectPatternsModel,
  ruleId: AxisProjectRule["id"],
  text: string,
): AxisProjectPatternEditResult {
  const entry = model.rules.find((rule) => rule.id === ruleId);
  if (entry === undefined) {
    return {
      ok: false,
      code: "unknown-rule",
      message: "That project rule is no longer available.",
    };
  }
  const normalizedText = text.trim();
  if (normalizedText.length === 0) {
    return { ok: false, code: "empty-text", message: "A pattern cannot be empty." };
  }
  if (entry.restrictionLocked) {
    return {
      ok: false,
      code: "inherited-restriction",
      message: "Inherited restrictions are locked and cannot be relaxed by a project override.",
    };
  }

  const base = entry.override ?? entry.effectiveRule;
  return {
    ok: true,
    change: {
      op: "set-rule",
      rule: {
        ...base,
        text: normalizedText,
        origin: "manual",
        sourceRef: entry.sourceRule.sourceRef,
        sourceRevision: entry.sourceRule.sourceRevision,
      },
    },
  };
}

export function buildRuleReplaceInput(
  model: AxisProjectPatternsModel,
  ruleId: AxisProjectRule["id"],
  text: string,
): AxisProjectProfileReplaceInput | Extract<AxisProjectPatternEditResult, { readonly ok: false }> {
  const result = buildRuleOverrideChange(model, ruleId, text);
  return result.ok
    ? { scope: model.scope, expectedRevision: model.revision, changes: [result.change] }
    : result;
}

export function buildResetOverrideInput(
  model: AxisProjectPatternsModel,
  ruleId: AxisProjectRule["id"],
): AxisProjectProfileResetOverrideInput | null {
  const entry = model.rules.find((rule) => rule.id === ruleId);
  return entry?.isOverridden
    ? { scope: model.scope, ruleId, expectedRevision: model.revision }
    : null;
}

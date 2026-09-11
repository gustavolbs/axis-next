// @effect-diagnostics nodeBuiltinImport:off - plan digest ties the proposal to the captured diff.
import * as NodeCrypto from "node:crypto";

import {
  AxisContextProjectScope,
  AxisProjectFact,
  AxisProjectProfile,
  AxisProjectRule,
  CommandId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { AxisProjectProfileStore } from "../projects/AxisProjectProfileStore.ts";

const TITLE_MAX = 240;
const BODY_MAX = 64_000;
const BRANCH_MAX = 256;
const TEMPLATE_NAME_MAX = 256;
const DIFF_DIGEST_MAX = 128;
const PROJECT_KEY_MAX = 128;
const RULE_TEXT_MAX = 2_000;
const SCOPE_GLOB_MAX = 512;

export const AxisPullRequestBranchPolicy = Schema.Literals([
  "production-develop",
  "main-env-production",
  "release-specific",
  "explicit",
]);
export type AxisPullRequestBranchPolicy = typeof AxisPullRequestBranchPolicy.Type;

export const AxisPullRequestPlanStatus = Schema.Literals(["ready", "draft", "blocked"]);
export type AxisPullRequestPlanStatus = typeof AxisPullRequestPlanStatus.Type;

const TrimmedTitle = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isMaxLength(TITLE_MAX),
);
const TrimmedBody = Schema.String.check(Schema.isMaxLength(BODY_MAX));
const TrimmedBranch = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isMaxLength(BRANCH_MAX),
);
const TrimmedTemplateName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isMaxLength(TEMPLATE_NAME_MAX),
);
const TrimmedDiffDigest = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isMaxLength(DIFF_DIGEST_MAX),
);
const TrimmedProjectKey = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isTrimmed(),
  Schema.isMaxLength(PROJECT_KEY_MAX),
);

const factText = (fact: AxisProjectFact): string => {
  if (fact.kind === "script") return fact.name;
  return fact.key;
};

const ruleMatchesPath = (rule: AxisProjectRule, path: string): boolean =>
  rule.paths.length === 0 || rule.paths.some((pattern) => globMatches(pattern, path));

const globMatches = (pattern: string, path: string): boolean => {
  if (pattern === path) return true;
  if (pattern.endsWith("**")) return path.startsWith(pattern.slice(0, -2));
  if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
  return false;
};

export const AxisPullRequestRuleRef = Schema.Struct({
  id: AxisProjectRule["fields"]["id"],
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(RULE_TEXT_MAX)),
  category: AxisProjectRule["fields"]["category"],
  paths: AxisProjectRule["fields"]["paths"],
  effect: AxisProjectRule["fields"]["effect"],
});
export type AxisPullRequestRuleRef = typeof AxisPullRequestRuleRef.Type;

export const AxisPullRequestPlan = Schema.Struct({
  scope: AxisContextProjectScope,
  commandId: CommandId,
  projectKey: TrimmedProjectKey,
  diffDigest: TrimmedDiffDigest,
  source: TrimmedBranch,
  destination: TrimmedBranch,
  branchPolicy: AxisPullRequestBranchPolicy,
  branch: TrimmedBranch,
  draft: Schema.Boolean,
  status: AxisPullRequestPlanStatus,
  title: TrimmedTitle,
  body: TrimmedBody,
  template: TrimmedTemplateName,
  applicableRules: Schema.Array(AxisPullRequestRuleRef).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  requiredChecks: Schema.Array(
    Schema.Struct({
      command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
      reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  blockers: Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(RULE_TEXT_MAX)),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type AxisPullRequestPlan = typeof AxisPullRequestPlan.Type;

export const AxisPullRequestPlanErrorReason = Schema.Literals([
  "invalid_input",
  "profile_missing",
  "diff_digest_mismatch",
  "policy_not_determined",
]);
export type AxisPullRequestPlanErrorReason = typeof AxisPullRequestPlanErrorReason.Type;

export class AxisPullRequestPlanError extends Schema.TaggedErrorClass<AxisPullRequestPlanError>()(
  "AxisPullRequestPlanError",
  { reason: AxisPullRequestPlanErrorReason, message: Schema.String },
) {}

export interface AxisPullRequestPlanRequest {
  readonly scope: AxisContextProjectScope;
  readonly commandId: CommandId;
  readonly projectKey: string;
  readonly diffDigest: string;
  readonly title: string;
  readonly summary: string;
  readonly touchedPaths: ReadonlyArray<string>;
  readonly branchHint?: string | null;
  readonly forceDraft?: boolean;
  readonly destinationOverride?: string | null;
  readonly sourceOverride?: string | null;
}

export interface AxisPullRequestPlanService {
  readonly prepare: (
    request: AxisPullRequestPlanRequest,
  ) => Effect.Effect<AxisPullRequestPlan, AxisPullRequestPlanError>;
}

export class AxisPullRequestPlanService extends Context.Service<AxisPullRequestPlanService>()(
  "t3/axis/tasks/AxisPullRequestPlan",
) {}

const RULE_CATEGORY_TO_CHECK: Readonly<Record<string, string>> = {
  tool: "Run the project's tooling check.",
  command: "Run the project's command check.",
  convention: "Honor the project convention.",
  "test-policy": "Run focused tests per the project test policy.",
  "pull-request-policy": "Honor the project PR policy.",
  path: "Limit changes to the project path policy.",
  instruction: "Honor the project instruction.",
};

const detectBranchPolicy = (rules: ReadonlyArray<AxisProjectRule>): AxisPullRequestBranchPolicy => {
  const haystack = rules
    .map((rule) => `${rule.id} ${rule.text} ${rule.paths.join(",")} ${rule.category}`)
    .join("\n");
  if (/production\s*(?:[/-]|->|→|to)\s*develop/iu.test(haystack)) return "production-develop";
  if (/main\s*(?:[/-]|->|→|to)\s*env[/-]production/iu.test(haystack)) return "main-env-production";
  if (/env[/-]production/iu.test(haystack) && !/main/.test(haystack)) return "main-env-production";
  if (/(release-specific|^release:)/imu.test(haystack)) return "release-specific";
  return "explicit";
};

const readFact = (facts: ReadonlyArray<AxisProjectFact>, key: string): string | undefined => {
  for (const fact of facts) {
    if (fact.kind === "value" && fact.key === key) return fact.value;
  }
  return undefined;
};

const resolveSourceAndDestination = (
  policy: AxisPullRequestBranchPolicy,
  facts: ReadonlyArray<AxisProjectFact>,
  hint: string | null,
  sourceOverride: string | null,
  destinationOverride: string | null,
): { source: string; destination: string; branchPolicy: AxisPullRequestBranchPolicy } => {
  const defaultBranch = readFact(facts, "default-branch") ?? "main";
  const productionBranch = readFact(facts, "production-branch") ?? "production";
  const envProductionBranch = readFact(facts, "env-production-branch") ?? "env/production";
  if (policy === "production-develop") {
    return {
      source: hint ?? "develop",
      destination: destinationOverride ?? defaultBranch,
      branchPolicy: "production-develop",
    };
  }
  if (policy === "main-env-production") {
    return {
      source: hint ?? defaultBranch,
      destination: destinationOverride ?? envProductionBranch,
      branchPolicy: "main-env-production",
    };
  }
  if (policy === "release-specific") {
    return {
      source: sourceOverride ?? hint ?? "release/current",
      destination: destinationOverride ?? envProductionBranch,
      branchPolicy: "release-specific",
    };
  }
  return {
    source: sourceOverride ?? hint ?? "feature/axis-change",
    destination: destinationOverride ?? productionBranch,
    branchPolicy: "explicit",
  };
};

const pickApplicableRules = (
  rules: ReadonlyArray<AxisProjectRule>,
  touchedPaths: ReadonlyArray<string>,
): ReadonlyArray<AxisPullRequestRuleRef["Type"]> => {
  const pathSet = new Set(touchedPaths.map((path) => path.trim()));
  const matches: AxisPullRequestRuleRef["Type"][] = [];
  for (const rule of rules) {
    if (rule.paths.length === 0) {
      matches.push({
        id: rule.id,
        text: rule.text,
        category: rule.category,
        paths: rule.paths,
        effect: rule.effect,
      });
      continue;
    }
    if ([...pathSet].some((path) => ruleMatchesPath(rule, path))) {
      matches.push({
        id: rule.id,
        text: rule.text,
        category: rule.category,
        paths: rule.paths,
        effect: rule.effect,
      });
    }
  }
  return matches;
};

const renderTemplate = (
  template: string,
  fields: {
    title: string;
    summary: string;
    branchPolicy: AxisPullRequestBranchPolicy;
    source: string;
    destination: string;
    applicableRules: ReadonlyArray<AxisPullRequestRuleRef["Type"]>;
    blockers: ReadonlyArray<string>;
    requiredChecks: ReadonlyArray<{ command: string; reason: string }>;
  },
) => {
  switch (template) {
    case "default":
      return [
        `## ${fields.title}`,
        "",
        fields.summary,
        "",
        `Branch policy: ${fields.branchPolicy}`,
        `Source: \`${fields.source}\` → Destination: \`${fields.destination}\``,
        "",
        "### Verification",
        ...fields.requiredChecks.map((check) => `- [ ] \`${check.command}\` — ${check.reason}`),
        "",
        "### Applicable rules",
        ...fields.applicableRules.map((rule) => `- ${rule.id}: ${rule.text}`),
      ].join("\n");
    case "minimal":
      return `${fields.title}\n\n${fields.summary}`;
    default:
      return fields.summary;
  }
};

export const make = Effect.gen(function* () {
  const profiles = yield* AxisProjectProfileStore;

  const prepare: AxisPullRequestPlanService["prepare"] = (raw) =>
    Effect.gen(function* () {
      const request = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          scope: AxisContextProjectScope,
          commandId: CommandId,
          projectKey: TrimmedProjectKey,
          diffDigest: TrimmedDiffDigest,
          title: TrimmedTitle,
          summary: Schema.String.check(Schema.isMaxLength(BODY_MAX)),
          touchedPaths: Schema.Array(
            Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(SCOPE_GLOB_MAX)),
          ),
          branchHint: Schema.optionalKey(Schema.NullOr(TrimmedBranch)),
          forceDraft: Schema.optionalKey(Schema.Boolean),
          destinationOverride: Schema.optionalKey(Schema.NullOr(TrimmedBranch)),
          sourceOverride: Schema.optionalKey(Schema.NullOr(TrimmedBranch)),
        }),
      )(raw).pipe(
        Effect.mapError(
          () =>
            new AxisPullRequestPlanError({
              reason: "invalid_input",
              message: "Pull request plan input did not validate.",
            }),
        ),
      );
      const profile = yield* profiles.get(request.scope).pipe(
        Effect.mapError(
          () =>
            new AxisPullRequestPlanError({
              reason: "profile_missing",
              message: "Project profile is unavailable; PR plan cannot be derived.",
            }),
        ),
      );
      const detected = detectBranchPolicy(profile.rules);
      if (
        detected === "explicit" &&
        (request.destinationOverride === null || request.destinationOverride === undefined)
      ) {
        return yield* new AxisPullRequestPlanError({
          reason: "policy_not_determined",
          message:
            "Project profile does not declare a destination policy; provide an explicit destination override.",
        });
      }
      const branches = resolveSourceAndDestination(
        detected,
        profile.facts,
        request.branchHint ?? null,
        request.sourceOverride ?? null,
        request.destinationOverride ?? null,
      );
      const applicable = pickApplicableRules(profile.rules, request.touchedPaths);
      const blockerTexts: string[] = [];
      if (request.touchedPaths.length === 0) {
        blockerTexts.push("No touched paths provided; PR body cannot enumerate scope.");
      }
      const requiredChecks = applicable.map((rule) => ({
        command:
          RULE_CATEGORY_TO_CHECK[rule.category] ??
          `pnpm vitest run --reporter=basic -- ${rule.paths[0] ?? "."}`,
        reason: `Apply rule ${rule.id}: ${rule.text}`,
      }));
      const status: AxisPullRequestPlanStatus =
        blockerTexts.length > 0 ? "blocked" : request.forceDraft === true ? "draft" : "ready";
      const branchName =
        request.branchHint ??
        (branches.branchPolicy === "release-specific"
          ? `release/${request.commandId}`
          : `feature/${request.commandId}`);
      const template = applicable.length > 0 ? "default" : "minimal";
      const body = renderTemplate(template, {
        title: request.title,
        summary: request.summary,
        branchPolicy: branches.branchPolicy,
        source: branches.source,
        destination: branches.destination,
        applicableRules: applicable,
        blockers: blockerTexts,
        requiredChecks,
      });
      const plan = Schema.decodeUnknownSync(AxisPullRequestPlan)({
        scope: request.scope,
        commandId: request.commandId,
        projectKey: request.projectKey,
        diffDigest: `sha256:${NodeCrypto.createHash("sha256")
          .update(
            JSON.stringify({
              diffDigest: request.diffDigest,
              title: request.title,
              summary: request.summary,
              branchPolicy: branches.branchPolicy,
              source: branches.source,
              destination: branches.destination,
              applicableRules: applicable.map((rule) => rule.id),
            }),
            "utf8",
          )
          .digest("hex")}`,
        source: branches.source,
        destination: branches.destination,
        branchPolicy: branches.branchPolicy,
        branch: branchName,
        draft: status !== "ready",
        status,
        title: request.title,
        body,
        template,
        applicableRules: applicable,
        requiredChecks,
        blockers: blockerTexts,
      });
      return plan;
    });

  return { prepare } satisfies AxisPullRequestPlanService;
});

export const layer = Layer.effect(AxisPullRequestPlanService, make);

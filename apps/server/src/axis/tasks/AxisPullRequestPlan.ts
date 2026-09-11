/**
 * W06 — AxisPullRequestPlan.
 *
 * Computes a pull request plan from a task, its effective project profile,
 * and a recorded self-review. The plan is the contract the publisher
 * consumes; preparing does not push or call the host, so a reviewer can
 * inspect destination, branch, title, body and required checks before
 * any external effect happens.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";

import {
  AxisContextProjectScope,
  AxisTaskExtension,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";

export const AxisPullRequestBranchMode = Schema.Literals([
  "current",
  "new-per-task",
  "release-specific",
]);
export type AxisPullRequestBranchMode = typeof AxisPullRequestBranchMode.Type;

export const AxisPullRequestDraftStrategy = Schema.Literals([
  "always-draft",
  "ready-by-default",
  "manual",
]);
export type AxisPullRequestDraftStrategy = typeof AxisPullRequestDraftStrategy.Type;

export const AxisPullRequestPlanInputSchema = Schema.Struct({
  scope: AxisContextProjectScope,
  task: AxisTaskExtension,
  review: Schema.Struct({
    findingsCount: Schema.Int,
    blockerCount: Schema.Int,
    approved: Schema.Boolean,
  }),
  branch: Schema.Struct({
    head: TrimmedNonEmptyString,
    base: TrimmedNonEmptyString,
  }),
  project: Schema.Struct({
    id: TrimmedNonEmptyString,
    defaultBranch: TrimmedNonEmptyString,
    productionBranch: Schema.NullOr(TrimmedNonEmptyString),
    draftStrategy: AxisPullRequestDraftStrategy,
    branchMode: AxisPullRequestBranchMode,
    templatePath: Schema.NullOr(TrimmedNonEmptyString),
    changelogPath: Schema.NullOr(TrimmedNonEmptyString),
    releaseBranchPrefix: Schema.NullOr(TrimmedNonEmptyString),
  }),
});
export type AxisPullRequestPlanInput = typeof AxisPullRequestPlanInputSchema.Type;

export const AxisPullRequestPlanSchema = Schema.Struct({
  scope: AxisContextProjectScope,
  task: AxisTaskExtension,
  branch: Schema.Struct({
    head: Schema.String,
    base: Schema.String,
  }),
  title: Schema.String,
  body: Schema.String,
  draft: Schema.Boolean,
  templatePath: Schema.NullOr(Schema.String),
  changelogPath: Schema.NullOr(Schema.String),
  requiredChecks: Schema.Array(Schema.String),
  regressionCandidates: Schema.Array(Schema.String),
  planDigest: Schema.String,
});
export type AxisPullRequestPlan = typeof AxisPullRequestPlanSchema.Type;

export class AxisPullRequestPlanError extends Schema.TaggedErrorClass<AxisPullRequestPlanError>()(
  "AxisPullRequestPlanError",
  {
    reason: Schema.Literals([
      "invalid_input",
      "scope_mismatch",
      "branch_conflict",
      "blocked_by_findings",
      "missing_template",
      "missing_changelog",
    ]),
    message: Schema.String,
  },
) {}

const error = (reason: AxisPullRequestPlanError["reason"], message: string) =>
  new AxisPullRequestPlanError({ reason, message });

const SLUG_PATTERN = /[^a-zA-Z0-9._/-]+/g;
const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replaceAll(SLUG_PATTERN, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "task";

const isSameScope = (left: AxisContextProjectScope, right: AxisContextProjectScope): boolean =>
  left.contextId === right.contextId &&
  left.project.environmentId === right.project.environmentId &&
  left.project.projectId === right.project.projectId;

const computeBranch = (
  input: AxisPullRequestPlanInput,
): Effect.Effect<{ readonly head: string; readonly base: string }, AxisPullRequestPlanError> =>
  Effect.gen(function* () {
    const desiredHead = (() => {
      switch (input.project.branchMode) {
        case "current":
          return input.branch.head;
        case "new-per-task":
          return `axis/${slugify(input.task.id)}`;
        case "release-specific":
          if (input.project.releaseBranchPrefix === null) {
            return input.branch.head;
          }
          return `${input.project.releaseBranchPrefix.replace(/\/+$/, "")}/${slugify(input.task.id)}`;
      }
    })();
    if (desiredHead === input.branch.base) {
      return yield* error(
        "branch_conflict",
        "The computed head branch matches the configured base branch.",
      );
    }
    return { head: desiredHead, base: input.branch.base };
  });

const buildBody = (input: AxisPullRequestPlanInput, branch: { head: string; base: string }) =>
  [
    `Task: ${input.task.title}`,
    `Scope: ${input.task.scope.contextId}/${input.task.scope.project.environmentId}/${input.task.scope.project.projectId}`,
    `Branch: ${branch.head} <- ${branch.base}`,
    "",
    "## Acceptance criteria",
    ...input.task.acceptanceCriteria.map((criterion) => `- [ ] ${criterion.text}`),
    "",
    "## Self-review",
    `- Findings: ${input.review.findingsCount}`,
    `- Blockers: ${input.review.blockerCount}`,
    `- Approved: ${input.review.approved ? "yes" : "no"}`,
  ].join("\n");

const planDigest = (
  input: AxisPullRequestPlanInput,
  branch: { head: string; base: string },
  title: string,
  body: string,
  draft: boolean,
) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        scope: input.scope,
        taskId: input.task.id,
        branch,
        title,
        body,
        draft,
        project: input.project,
        review: input.review,
      }),
      "utf8",
    )
    .digest("hex");

export const planAxisPullRequest = (
  input: AxisPullRequestPlanInput,
): Effect.Effect<AxisPullRequestPlan, AxisPullRequestPlanError> =>
  Effect.gen(function* () {
    if (input.task.scope.contextId !== input.scope.contextId) {
      return yield* error("scope_mismatch", "The task scope does not match the plan scope.");
    }
    if (input.review.blockerCount > 0 && input.review.approved) {
      return yield* error("invalid_input", "A review with blockers cannot be marked as approved.");
    }
    if (input.review.blockerCount > 0) {
      return yield* error(
        "blocked_by_findings",
        "Self-review reported blockers; resolve them before preparing a pull request.",
      );
    }
    const branch = yield* computeBranch(input);
    if (
      input.project.draftStrategy === "always-draft" &&
      input.project.productionBranch !== null &&
      input.project.productionBranch === branch.base
    ) {
      return yield* error(
        "invalid_input",
        "Production destinations must use the manual draft strategy; configure a different base.",
      );
    }
    const draft = (() => {
      switch (input.project.draftStrategy) {
        case "always-draft":
          return true;
        case "ready-by-default":
          return false;
        case "manual":
          return input.review.findingsCount > 0;
      }
    })();
    const title = `${input.task.title} (${input.task.id})`;
    const body = buildBody(input, branch);
    const requiredChecks: string[] = [];
    if (input.review.approved) requiredChecks.push("self-review-approved");
    if (input.review.findingsCount > 0) requiredChecks.push("self-review-resolved");
    if (input.project.productionBranch === branch.base) {
      requiredChecks.push("production-pretest");
    }
    if (input.project.branchMode === "release-specific") {
      requiredChecks.push("release-notes");
    }
    return {
      scope: input.scope,
      task: input.task,
      branch,
      title,
      body,
      draft,
      templatePath: input.project.templatePath,
      changelogPath: input.project.changelogPath,
      requiredChecks,
      regressionCandidates: input.task.acceptanceCriteria.map((criterion) => criterion.id),
      planDigest: planDigest(input, branch, title, body, draft),
    } satisfies AxisPullRequestPlan;
  });

export const plansAreEqual = (left: AxisPullRequestPlan, right: AxisPullRequestPlan): boolean =>
  left.planDigest === right.planDigest;

export const sameScope = (left: AxisContextProjectScope, right: AxisContextProjectScope): boolean =>
  isSameScope(left, right);

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  AxisPullRequestPlanError,
  planAxisPullRequest,
  plansAreEqual,
  sameScope,
} from "./AxisPullRequestPlan.ts";
import {
  AxisTaskId,
  AxisTaskStepId,
  type AxisTaskExtension,
  type AxisContextProjectScope,
} from "@t3tools/contracts";

const scope: AxisContextProjectScope = {
  contextId: "ctx-1",
  project: { environmentId: "env-1", projectId: "proj-1" },
};

const baseTask: AxisTaskExtension = {
  id: AxisTaskId.make("task-1"),
  scope,
  threadId: "thread-1" as never,
  title: "Fix onboarding copy",
  acceptanceCriteria: [
    { id: AxisTaskStepId.make("c-1"), text: "The copy is shorter than 80 chars." },
    { id: AxisTaskStepId.make("c-2"), text: "Lint passes." },
  ],
  workflowVersion: "1.0.0",
  steps: [
    {
      id: AxisTaskStepId.make("step-1"),
      skillId: "implement" as never,
      status: "completed",
      turnId: null,
      commandId: null,
      reason: null,
      startedAt: null,
      finishedAt: null,
    },
  ],
  status: "active",
  revision: 1,
  createdAt: "2026-09-11T00:00:00.000Z",
  updatedAt: "2026-09-11T00:00:00.000Z",
};

const baseInput = {
  scope,
  task: baseTask,
  review: { findingsCount: 0, blockerCount: 0, approved: true },
  branch: { head: "feat/some-branch", base: "main" },
  project: {
    id: "proj-1",
    defaultBranch: "main",
    productionBranch: null,
    draftStrategy: "always-draft" as const,
    branchMode: "new-per-task" as const,
    templatePath: ".github/pull_request_template.md",
    changelogPath: "CHANGELOG.md",
    releaseBranchPrefix: null,
  },
};

it.effect("planAxisPullRequest honors branch mode, draft strategy, and required checks", () =>
  Effect.gen(function* () {
    const plan = yield* planAxisPullRequest(baseInput);
    assert.equal(plan.branch.head, "axis/task-1");
    assert.equal(plan.branch.base, "main");
    assert.equal(plan.draft, true);
    assert.deepEqual(plan.requiredChecks, ["self-review-approved"]);
    assert.equal(plan.body.includes("Acceptance criteria"), true);
  }),
);

it.effect("release-specific branch mode prefixes the release branch and adds the check", () =>
  Effect.gen(function* () {
    const plan = yield* planAxisPullRequest({
      ...baseInput,
      project: {
        ...baseInput.project,
        branchMode: "release-specific",
        releaseBranchPrefix: "release",
        changelogPath: "CHANGELOG.md",
        draftStrategy: "manual",
      },
    });
    assert.equal(plan.branch.head, "release/task-1");
    assert.deepEqual(plan.requiredChecks, ["self-review-approved", "release-notes"]);
  }),
);

it.effect("production branch forces manual strategy", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      planAxisPullRequest({
        ...baseInput,
        project: {
          ...baseInput.project,
          productionBranch: "main",
          draftStrategy: "always-draft",
        },
      }),
    );
    assert.instanceOf(error, AxisPullRequestPlanError);
  }),
);

it.effect("blocker findings block the plan", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      planAxisPullRequest({
        ...baseInput,
        review: { findingsCount: 1, blockerCount: 1, approved: true },
      }),
    );
    assert.instanceOf(error, AxisPullRequestPlanError);
  }),
);

it.effect("approved with blockers is rejected", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      planAxisPullRequest({
        ...baseInput,
        review: { findingsCount: 2, blockerCount: 1, approved: true },
      }),
    );
    assert.instanceOf(error, AxisPullRequestPlanError);
  }),
);

it.effect("scope mismatch is rejected", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      planAxisPullRequest({
        ...baseInput,
        scope: { ...scope, contextId: "ctx-other" },
      }),
    );
    assert.instanceOf(error, AxisPullRequestPlanError);
  }),
);

it.effect("branch conflict when head equals base", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      planAxisPullRequest({
        ...baseInput,
        branch: { head: "main", base: "main" },
        project: { ...baseInput.project, branchMode: "current" },
      }),
    );
    assert.instanceOf(error, AxisPullRequestPlanError);
  }),
);

it.effect("plansAreEqual is content-addressed and ignores unrelated timing fields", () =>
  Effect.gen(function* () {
    const planA = yield* planAxisPullRequest(baseInput);
    const planB = yield* planAxisPullRequest({
      ...baseInput,
      task: { ...baseInput.task, updatedAt: "2030-01-01T00:00:00.000Z" },
    });
    assert.equal(plansAreEqual(planA, planB), true);
    const planC = yield* planAxisPullRequest({
      ...baseInput,
      review: { findingsCount: 1, blockerCount: 0, approved: true },
    });
    assert.equal(plansAreEqual(planA, planC), false);
    assert.equal(sameScope(scope, scope), true);
    assert.equal(
      sameScope(scope, { ...scope, project: { environmentId: "env-2", projectId: "proj-1" } }),
      false,
    );
  }),
);

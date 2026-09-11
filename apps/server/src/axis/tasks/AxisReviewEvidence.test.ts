import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import {
  AxisReviewEvidenceError,
  diffDigestFor,
  recordAxisReviewEvidence,
  revalidateAxisReviewEvidence,
} from "./AxisReviewEvidence.ts";
import {
  AxisContextId,
  AxisTaskId,
  AxisTaskStepId,
  CommandId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

const scope = {
  contextId: AxisContextId.make("ctx-1"),
  project: {
    environmentId: EnvironmentId.make("env-1"),
    projectId: ProjectId.make("proj-1"),
  },
} as const;

const baseReview = {
  scope,
  taskId: AxisTaskId.make("task-1"),
  stepId: AxisTaskStepId.make("step-1"),
  commandId: CommandId.make("cmd-1"),
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
  baseSha: "base-sha-1",
  headSha: "head-sha-1",
  diffDigest: diffDigestFor({
    baseSha: "base-sha-1",
    headSha: "head-sha-1",
    diff: "+line\n-line",
  }),
  filesCovered: ["apps/server/src/foo.ts", "apps/server/src/bar.ts"],
  rulesUsed: ["tests-must-pass", "lint-must-pass"],
  findings: [
    {
      id: "f-1",
      severity: "blocker" as const,
      summary: "Missing test for the new helper.",
      evidence: "apps/server/src/foo.ts:42",
    },
  ],
  reviewer: "self-review",
  note: null,
};

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("AxisReviewEvidence", (it) => {
  it.effect(
    "records a review, returns the same snapshot on retry, rejects divergent payloads, and revalidates against current diff",
    () =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 67 });

        const first = yield* recordAxisReviewEvidence(baseReview);
        assert.equal(first.alreadyRecorded, false);
        assert.equal(first.snapshot.findings.length, 1);

        const replay = yield* recordAxisReviewEvidence(baseReview);
        assert.equal(replay.alreadyRecorded, true);
        assert.equal(replay.snapshot.recordedAt, first.snapshot.recordedAt);

        const divergentError = yield* Effect.flip(
          recordAxisReviewEvidence({
            ...baseReview,
            note: "Reconsidered after re-reading the diff.",
          }),
        );
        assert.equal(divergentError._tag, "AxisReviewEvidenceError");
        if (divergentError instanceof AxisReviewEvidenceError) {
          assert.equal(divergentError.reason, "duplicate");
        }

        const revalidated = yield* revalidateAxisReviewEvidence({
          scope,
          taskId: baseReview.taskId,
          stepId: baseReview.stepId,
          currentDiffDigest: baseReview.diffDigest,
          currentHeadSha: baseReview.headSha,
        });
        assert.notEqual(revalidated, null);
        assert.equal(revalidated?.findings[0]?.id, "f-1");

        const staleDiffError = yield* Effect.flip(
          revalidateAxisReviewEvidence({
            scope,
            taskId: baseReview.taskId,
            stepId: baseReview.stepId,
            currentDiffDigest: "different-diff-digest",
            currentHeadSha: baseReview.headSha,
          }),
        );
        assert.equal(staleDiffError._tag, "AxisReviewEvidenceError");
        if (staleDiffError instanceof AxisReviewEvidenceError) {
          assert.equal(staleDiffError.reason, "stale_review");
        }

        const headChangedError = yield* Effect.flip(
          revalidateAxisReviewEvidence({
            scope,
            taskId: baseReview.taskId,
            stepId: baseReview.stepId,
            currentDiffDigest: baseReview.diffDigest,
            currentHeadSha: "different-head",
          }),
        );
        assert.equal(headChangedError._tag, "AxisReviewEvidenceError");
        if (headChangedError instanceof AxisReviewEvidenceError) {
          assert.equal(headChangedError.reason, "head_changed");
        }
      }),
  );

  it.effect("rejects empty reviews", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 67 });
      const emptyError = yield* Effect.flip(
        recordAxisReviewEvidence({
          ...baseReview,
          commandId: CommandId.make("cmd-empty"),
          findings: [],
          note: null,
        }),
      );
      assert.equal(emptyError._tag, "AxisReviewEvidenceError");
      if (emptyError instanceof AxisReviewEvidenceError) {
        assert.equal(emptyError.reason, "invalid_input");
      }
    }),
  );

  it.effect("isolates reviews by scope", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 67 });

      const scopeA = scope;
      const scopeB = {
        ...scope,
        project: {
          environmentId: EnvironmentId.make("env-2"),
          projectId: ProjectId.make("proj-1"),
        },
      };
      yield* recordAxisReviewEvidence(baseReview);
      const other = yield* recordAxisReviewEvidence({
        ...baseReview,
        scope: scopeB,
        reviewer: "second-reviewer",
      });
      assert.equal(other.alreadyRecorded, false);
      assert.equal(other.snapshot.reviewer, "second-reviewer");
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import {
  AxisReviewFeedbackError,
  feedbackFingerprintFor,
  recordAxisReviewFeedback,
} from "./AxisReviewFeedback.ts";
import { AxisContextId, CommandId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { AxisReviewFeedbackResult } from "./AxisReviewFeedback.ts";

const scope = {
  contextId: AxisContextId.make("ctx-1"),
  project: {
    environmentId: EnvironmentId.make("env-1"),
    projectId: ProjectId.make("proj-1"),
  },
} as const;

const baseFeedback = {
  scope,
  taskId: "task-1",
  threadId: "thread-1",
  commandId: CommandId.make("cmd-1"),
  source: {
    kind: "thread-comment" as const,
    sourceId: "comment-1",
    cursor: "cursor-1",
    url: "https://example/pr/1#comment-1",
  },
  comment: {
    author: "reviewer-1",
    body: "Please add a regression test for the helper.",
    path: "apps/server/src/axis/tasks/AxisReviewFeedback.ts",
    line: 42,
    severity: "suggestion" as const,
    createdAt: "2026-09-11T00:00:00.000Z",
  },
  resolution: {
    outcome: "accepted" as const,
    note: "Added the test in the same PR.",
    decidedBy: "self",
    decidedAt: "2026-09-11T01:00:00.000Z",
  },
};

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

let first: AxisReviewFeedbackResult = {
  evidenceId: "" as never,
  recordedAt: "",
  alreadyRecorded: false,
};

layer("AxisReviewFeedback", (it) => {
  it.effect("records the feedback idempotently and updates an existing row", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 68 });

      first = yield* recordAxisReviewFeedback(baseFeedback);
      assert.equal(first.alreadyRecorded, false);
      const second = yield* recordAxisReviewFeedback(baseFeedback);
      assert.equal(second.alreadyRecorded, false);
      assert.equal(second.recordedAt, first.recordedAt);
      assert.equal(second.evidenceId, first.evidenceId);

      const updated = yield* recordAxisReviewFeedback({
        ...baseFeedback,
        resolution: { ...baseFeedback.resolution, outcome: "rejected" },
      });
      assert.equal(updated.evidenceId, first.evidenceId);
      assert.notEqual(updated.recordedAt, "");
    }),
  );

  it.effect("isolates feedback by scope", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 68 });

      yield* recordAxisReviewFeedback(baseFeedback);
      const otherScope = {
        contextId: AxisContextId.make("ctx-1"),
        project: {
          environmentId: EnvironmentId.make("env-2"),
          projectId: ProjectId.make("proj-1"),
        },
      };
      const other = yield* recordAxisReviewFeedback({
        ...baseFeedback,
        scope: otherScope,
        comment: { ...baseFeedback.comment, body: "Different body." },
      });
      assert.equal(other.alreadyRecorded, false);
      assert.notEqual(other.evidenceId, first.evidenceId);
    }),
  );

  it.effect("supports different source kinds and severities without colliding", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 68 });

      const reviewAction = yield* recordAxisReviewFeedback({
        ...baseFeedback,
        commandId: CommandId.make("cmd-2"),
        source: {
          kind: "review-action",
          sourceId: "action-1",
          cursor: "cursor-1",
          url: null,
        },
      });
      assert.equal(reviewAction.alreadyRecorded, false);
      assert.notEqual(reviewAction.evidenceId, "");
      assert.notEqual(
        feedbackFingerprintFor(baseFeedback),
        feedbackFingerprintFor({
          ...baseFeedback,
          source: {
            kind: "review-comment",
            sourceId: "comment-1",
            cursor: "cursor-1",
            url: null,
          },
        }),
      );
    }),
  );
});

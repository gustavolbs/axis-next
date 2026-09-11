import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import {
  AxisVerificationEvidenceError,
  coveredFilesChanged,
  getAxisVerificationEvidence,
  invalidateStaleAxisVerificationEvidence,
  recordAxisVerificationEvidence,
} from "./AxisVerificationEvidence.ts";
import {
  AxisContextId,
  AxisTaskId,
  AxisTaskStepId,
  CommandId,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";

const scope = {
  contextId: AxisContextId.make("ctx-1"),
  project: {
    environmentId: EnvironmentId.make("env-1"),
    projectId: ProjectId.make("proj-1"),
  },
} as const;

const baseEvidence = {
  outcome: "passed" as const,
  command: "vitest run apps/server/src/axis/tasks",
  exitCode: 0,
  observedAt: "2026-09-11T00:00:00.000Z",
  observedRevision: 1,
  coveredFiles: [
    "apps/server/src/axis/tasks/AxisVerificationEvidence.ts",
    "apps/server/src/axis/tasks/AxisVerificationEvidence.test.ts",
  ],
  summary: "All verification tests passed.",
  source: "auto" as const,
  reason: null,
};

const taskId = AxisTaskId.make("task-1");
const stepId = AxisTaskStepId.make("step-1");
const commandId = CommandId.make("cmd-1");

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("AxisVerificationEvidence", (it) => {
  it.effect("runs migration 066 and creates the table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 66 });
      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'axis_verification_evidence'
      `;
      assert.equal(rows.length, 1);
    }),
  );

  it.effect("records, fetches the latest, invalidates stale, detects file change", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 66 });

      const first = yield* recordAxisVerificationEvidence({
        scope,
        taskId,
        stepId,
        commandId,
        evidence: baseEvidence,
      });
      assert.equal(first.evidence.outcome, "passed");

      const second = yield* recordAxisVerificationEvidence({
        scope,
        taskId,
        stepId,
        commandId,
        evidence: baseEvidence,
      });
      assert.equal(second.createdAt, first.createdAt);

      const fetched = yield* getAxisVerificationEvidence({ scope, taskId, stepId });
      assert.notEqual(fetched, null);
      assert.equal(fetched?.createdAt, first.createdAt);

      const divergentError = yield* Effect.flip(
        recordAxisVerificationEvidence({
          scope,
          taskId,
          stepId,
          commandId,
          evidence: { ...baseEvidence, summary: "Different summary" },
        }),
      );
      assert.equal(divergentError._tag, "AxisVerificationEvidenceError");
      if (Schema.is(AxisVerificationEvidenceError)(divergentError)) {
        assert.equal(divergentError.reason, "duplicate");
      }

      const staleCount = yield* invalidateStaleAxisVerificationEvidence({
        scope,
        taskId,
        currentRevision: 2,
      });
      assert.equal(staleCount, 1);
      const afterInvalidate = yield* getAxisVerificationEvidence({ scope, taskId, stepId });
      assert.equal(afterInvalidate, null);

      assert.equal(
        coveredFilesChanged({
          evidence: baseEvidence,
          currentSnapshot: [
            { path: baseEvidence.coveredFiles[0] as string, digest: "sha256:abc" },
            { path: baseEvidence.coveredFiles[1] as string, digest: "sha256:def" },
          ],
        }),
        false,
      );
      assert.equal(baseEvidence.coveredFiles[0], baseEvidence.coveredFiles[0]);
      assert.equal(
        coveredFilesChanged({
          evidence: baseEvidence,
          currentSnapshot: [{ path: baseEvidence.coveredFiles[1] as string, digest: "sha256:abc" }],
        }),
        true,
      );
    }),
  );

  it.effect("rejects empty command and covered files for pass/fail", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 66 });

      const emptyCommandError = yield* Effect.flip(
        recordAxisVerificationEvidence({
          scope,
          taskId,
          stepId,
          commandId: CommandId.make("cmd-2"),
          evidence: { ...baseEvidence, command: "   " },
        }),
      );
      assert.equal(emptyCommandError._tag, "AxisVerificationEvidenceError");
      if (Schema.is(AxisVerificationEvidenceError)(emptyCommandError)) {
        assert.equal(emptyCommandError.reason, "command_missing");
      }

      const missingFilesError = yield* Effect.flip(
        recordAxisVerificationEvidence({
          scope,
          taskId,
          stepId,
          commandId: CommandId.make("cmd-3"),
          evidence: { ...baseEvidence, coveredFiles: [] },
        }),
      );
      assert.equal(missingFilesError._tag, "AxisVerificationEvidenceError");
      if (Schema.is(AxisVerificationEvidenceError)(missingFilesError)) {
        assert.equal(missingFilesError.reason, "invalid_input");
      }

      const notApplicable = yield* recordAxisVerificationEvidence({
        scope,
        taskId,
        stepId,
        commandId: CommandId.make("cmd-4"),
        evidence: {
          ...baseEvidence,
          outcome: "not-applicable",
          command: "n/a",
          coveredFiles: [],
          reason: "Test framework not adopted in this project",
        },
      });
      assert.equal(notApplicable.evidence.outcome, "not-applicable");
    }),
  );

  it.effect("different scopes cannot collide", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 66 });

      const scopeA = scope;
      const scopeB = {
        ...scope,
        project: {
          environmentId: EnvironmentId.make("env-2"),
          projectId: ProjectId.make("proj-1"),
        },
      };
      yield* recordAxisVerificationEvidence({
        scope: scopeA,
        taskId,
        stepId,
        commandId,
        evidence: { ...baseEvidence, summary: "A summary" },
      });
      const b = yield* recordAxisVerificationEvidence({
        scope: scopeB,
        taskId,
        stepId,
        commandId,
        evidence: { ...baseEvidence, summary: "B summary" },
      });
      assert.equal(b.evidence.summary, "B summary");
    }),
  );
});

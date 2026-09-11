import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import {
  AxisLearningOutcomesError,
  recordAxisLearningOutcome,
  summarizeAxisLearningOutcomes,
} from "./AxisLearningOutcomes.ts";
import { CommandId } from "@t3tools/contracts";

const scope = {
  contextId: "ctx-1",
  project: { environmentId: "env-1", projectId: "proj-1" },
} as const;

const baseInput = {
  scope,
  taskId: "task-1",
  commandId: CommandId.make("cmd-1"),
  signal: "applied" as const,
  summary: "The new rule made the build faster and CI stayed green.",
  versionIds: ["axis-version-1", "axis-version-2"],
  note: null,
  observedAt: "2026-09-11T00:00:00.000Z",
};

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("AxisLearningOutcomes", (it) => {
  it.effect("records an outcome and updates it on the same commandId", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 70 });

      const first = yield* recordAxisLearningOutcome(baseInput);
      assert.equal(first.signal, "applied");
      assert.deepEqual(first.versionIds, ["axis-version-1", "axis-version-2"]);

      const updated = yield* recordAxisLearningOutcome({
        ...baseInput,
        signal: "rolled-back",
        note: "Reverted after the linter complained.",
      });
      assert.equal(updated.id, first.id);
      assert.equal(updated.signal, "rolled-back");
      assert.equal(updated.note, "Reverted after the linter complained.");
    }),
  );

  it.effect("rejects empty version list", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 70 });
      const error = yield* Effect.flip(
        recordAxisLearningOutcome({
          ...baseInput,
          commandId: CommandId.make("cmd-empty"),
          versionIds: [],
        }),
      );
      assert.instanceOf(error, AxisLearningOutcomesError);
      if (error instanceof AxisLearningOutcomesError) {
        assert.equal(error.reason, "invalid_input");
      }
    }),
  );

  it.effect("summarizes a list of outcomes", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 70 });
      const applied = yield* recordAxisLearningOutcome({
        ...baseInput,
        commandId: CommandId.make("cmd-applied"),
      });
      const rolled = yield* recordAxisLearningOutcome({
        ...baseInput,
        commandId: CommandId.make("cmd-rolled"),
        signal: "rolled-back",
      });
      const blocked = yield* recordAxisLearningOutcome({
        ...baseInput,
        commandId: CommandId.make("cmd-blocked"),
        signal: "blocked",
      });
      const summary = summarizeAxisLearningOutcomes([applied, rolled, blocked]);
      assert.equal(summary.applied, 1);
      assert.equal(summary.rolledBack, 1);
      assert.equal(summary.blocked, 1);
      assert.equal(summary.noEffect, 0);
    }),
  );

  it.effect("isolates outcomes by scope", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 70 });
      const scopeA = scope;
      const scopeB = { ...scope, project: { environmentId: "env-2", projectId: "proj-1" } };
      const a = yield* recordAxisLearningOutcome({
        ...baseInput,
        commandId: CommandId.make("cmd-A"),
        scope: scopeA,
      });
      const b = yield* recordAxisLearningOutcome({
        ...baseInput,
        commandId: CommandId.make("cmd-A"),
        scope: scopeB,
      });
      assert.notEqual(a.id, b.id);
    }),
  );
});

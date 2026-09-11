import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { createAxisTaskFromIntake } from "./AxisTaskIntake.ts";
import { AxisContextId, CommandId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

const scope = {
  contextId: AxisContextId.make("ctx-1"),
  project: {
    environmentId: EnvironmentId.make("env-1"),
    projectId: ProjectId.make("proj-1"),
  },
} as const;

const baseInput = {
  scope,
  commandId: CommandId.make("cmd-1"),
  threadId: ThreadId.make("thread-1"),
  source: {
    kind: "local" as const,
    label: "user-pasted-task",
  },
  objective: "Add a regression test for the helper that fixes onboarding copy.",
  acceptanceCriteria: [
    { text: "The helper test asserts the new behavior." },
    { text: "Lint passes." },
  ],
  workflowVersion: "1.0.0",
  steps: ["intake", "implement", "verify"],
};

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("AxisTaskIntake", (it) => {
  it.effect("creates a task from a local source and is idempotent on the same commandId", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 69 });

      const first = yield* createAxisTaskFromIntake(baseInput);
      assert.equal(first.alreadyExists, false);
      assert.equal(first.task.source?.kind, "local");
      assert.equal(first.task.acceptanceCriteria.length, 2);

      const replay = yield* createAxisTaskFromIntake(baseInput);
      assert.equal(replay.alreadyExists, true);
      assert.equal(replay.task.id, first.task.id);
    }),
  );

  it.effect("a different commandId with the same local label still creates a task", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 69 });

      const first = yield* createAxisTaskFromIntake(baseInput);
      const retry = yield* createAxisTaskFromIntake({
        ...baseInput,
        commandId: CommandId.make("cmd-2"),
      });
      assert.equal(retry.alreadyExists, false);
      assert.notEqual(retry.task.id, first.task.id);
    }),
  );

  it.effect("collapses on the same jira issueKey across commands", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 69 });

      const jiraInput = {
        ...baseInput,
        commandId: CommandId.make("cmd-jira-1"),
        source: {
          kind: "jira" as const,
          issueKey: "PROJ-123",
        },
      };
      const first = yield* createAxisTaskFromIntake(jiraInput);
      const retry = yield* createAxisTaskFromIntake({
        ...jiraInput,
        commandId: CommandId.make("cmd-jira-2"),
      });
      assert.equal(retry.alreadyExists, true);
      assert.equal(retry.task.id, first.task.id);
    }),
  );

  it.effect("trello intake maps the source card id and returns the task", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 69 });

      const trello = yield* createAxisTaskFromIntake({
        ...baseInput,
        commandId: CommandId.make("cmd-trello-1"),
        source: {
          kind: "trello" as const,
          cardId: "card-abc",
        },
      });
      assert.equal(trello.alreadyExists, false);
      const trelloSource = trello.task.source;
      if (trelloSource?.kind === "trello") {
        assert.equal(trelloSource.cardId, "card-abc");
      } else {
        assert.fail("Expected trello source");
      }
    }),
  );

  it.effect("defaults the acceptance criterion and steps when omitted", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 69 });
      const result = yield* createAxisTaskFromIntake({
        ...baseInput,
        commandId: CommandId.make("cmd-default-1"),
        acceptanceCriteria: [],
        steps: [],
      });
      assert.equal(result.task.acceptanceCriteria.length, 1);
      assert.equal(result.task.steps.length, 3);
    }),
  );
});

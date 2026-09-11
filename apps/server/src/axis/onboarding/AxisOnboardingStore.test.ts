import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AxisOnboardingRunId,
  AxisOnboardingSourceId,
  AxisOnboardingRun,
  type AxisOnboardingRun as AxisOnboardingRunType,
} from "../../../../../packages/contracts/src/axisOnboarding.ts";
import { AxisContextProjectScope } from "../../../../../packages/contracts/src/axisProjectProfile.ts";
import { CommandId, ThreadId, TurnId } from "../../../../../packages/contracts/src/baseSchemas.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  AxisOnboardingCommandConflictError,
  AxisOnboardingPersistenceError,
  AxisOnboardingStore,
  layer as storeLayer,
} from "./AxisOnboardingStore.ts";
import { runMigrations } from "../../persistence/Migrations.ts";

const persistence = NodeSqliteClient.layerMemory();
const testLayer = Layer.merge(persistence, storeLayer.pipe(Layer.provide(persistence)));
const layer = it.layer(testLayer);
const decodeScope = Schema.decodeUnknownSync(AxisContextProjectScope);
const decodeRun = Schema.decodeUnknownSync(AxisOnboardingRun);

const scope = decodeScope({
  contextId: "company",
  project: { environmentId: "laptop", projectId: "project-a" },
});
const otherScope = decodeScope({
  contextId: "company",
  project: { environmentId: "desktop", projectId: "project-a" },
});

const runningRun = decodeRun({
  id: "onboarding-1",
  scope,
  execution: { threadId: "thread-1", turnId: "turn-1", commandId: "command-start-1" },
  status: "running",
  sources: [],
  digests: [],
  facts: [],
  candidateRules: [],
  conflicts: [],
  decisions: [],
  error: null,
  startedAt: "2026-09-10T10:00:00.000Z",
  finishedAt: null,
});

const withStatus = (status: "cancelled" | "failed" | "completed"): AxisOnboardingRunType =>
  status === "failed"
    ? { ...runningRun, status, error: "Provider stopped.", finishedAt: "2026-09-10T10:01:00.000Z" }
    : { ...runningRun, status, error: null, finishedAt: "2026-09-10T10:01:00.000Z" };

layer("AxisOnboardingStore", (it) => {
  it.effect("persists every lifecycle state by physical scope and keeps execution links", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* AxisOnboardingStore;
      const sql = yield* SqlClient.SqlClient;

      yield* store.save(runningRun);
      yield* store.save(withStatus("cancelled"));
      yield* store.save(withStatus("failed"));
      yield* store.save(withStatus("completed"));

      const metadata = (yield* sql<{
        readonly runId: string;
        readonly contextId: string;
        readonly scopeKey: string;
        readonly environmentId: string;
        readonly projectId: string;
        readonly threadId: string;
        readonly turnId: string;
        readonly status: string;
      }>`
        SELECT run_id AS "runId", context_id AS "contextId", scope_key AS "scopeKey",
          environment_id AS "environmentId", project_id AS "projectId", thread_id AS "threadId",
          turn_id AS "turnId", status
        FROM axis_onboarding_runs WHERE run_id = ${runningRun.id}
      `)[0];
      assert.deepEqual(metadata, {
        runId: runningRun.id,
        contextId: scope.contextId,
        scopeKey: 'project:["laptop","project-a"]',
        environmentId: scope.project.environmentId,
        projectId: scope.project.projectId,
        threadId: runningRun.execution.threadId,
        turnId: runningRun.execution.turnId,
        status: "completed",
      });
      const saved = yield* store.get(scope, runningRun.id);
      assert.isTrue(Option.isSome(saved));
      const savedRun = Option.getOrThrow(saved);
      assert.equal(savedRun.status, "completed");
      assert.deepEqual(savedRun.execution, runningRun.execution);
      assert.equal((yield* store.list(scope)).length, 1);
      assert.equal((yield* store.list(otherScope)).length, 0);

      const row = (yield* sql<{ readonly runJson: string }>`
        SELECT run_json AS "runJson" FROM axis_onboarding_runs
        WHERE context_id = ${scope.contextId} AND run_id = ${runningRun.id}
      `)[0];
      assert.isString(row?.runJson);
      assert.notInclude(row?.runJson ?? "", "messages");
      assert.notInclude(row?.runJson ?? "", "providerState");
      assert.notInclude(row?.runJson ?? "", "sessionId");
    }),
  );

  it.effect("makes start, cancel, and retry transactional and idempotent by commandId", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* AxisOnboardingStore;
      const sql = yield* SqlClient.SqlClient;
      const run = decodeRun({
        ...runningRun,
        id: AxisOnboardingRunId.make("onboarding-idempotent"),
        execution: {
          ...runningRun.execution,
          commandId: CommandId.make("command-start-idempotent"),
        },
      });
      const started = yield* store.start({ run });
      const startedAgain = yield* store.start({ run });
      assert.deepEqual(startedAgain, started);

      const startConflict = yield* Effect.flip(
        store.start({
          run: decodeRun({
            ...run,
            sources: [
              {
                id: AxisOnboardingSourceId.make("source-1"),
                path: "AGENTS.md",
                kind: "instruction",
                status: "absent",
                error: null,
              },
            ],
          }),
        }),
      );
      assert.instanceOf(startConflict, AxisOnboardingCommandConflictError);

      const cancelled = yield* store.cancel(scope, {
        runId: run.id,
        commandId: CommandId.make("command-cancel-1"),
        reason: "User stopped the scan.",
      });
      const cancelledAgain = yield* store.cancel(scope, {
        runId: run.id,
        commandId: CommandId.make("command-cancel-1"),
        reason: "User stopped the scan.",
      });
      assert.equal(cancelled.status, "cancelled");
      assert.deepEqual(cancelledAgain, cancelled);

      const retried = yield* store.retry(scope, {
        runId: run.id,
        commandId: CommandId.make("command-retry-1"),
      });
      const retriedAgain = yield* store.retry(scope, {
        runId: run.id,
        commandId: CommandId.make("command-retry-1"),
      });
      assert.equal(retried.status, "running");
      assert.equal(retried.finishedAt, null);
      assert.deepEqual(retried.execution, run.execution);
      assert.deepEqual(retriedAgain, retried);

      const counts = yield* sql<{ readonly runs: number; readonly commands: number }>`
        SELECT
          (SELECT COUNT(*) FROM axis_onboarding_runs) AS runs,
          (SELECT COUNT(*) FROM axis_onboarding_commands) AS commands
      `;
      assert.deepEqual(counts[0], { runs: 2, commands: 3 });
    }),
  );

  it.effect("rejects malformed persisted JSON and preserves scope isolation", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* AxisOnboardingStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.save(runningRun);
      yield* store.save({
        ...runningRun,
        id: AxisOnboardingRunId.make("onboarding-other-scope"),
        scope: otherScope,
        execution: {
          ...runningRun.execution,
          threadId: ThreadId.make("thread-other"),
          turnId: TurnId.make("turn-other"),
        },
      });

      yield* sql`
        UPDATE axis_onboarding_runs SET run_json = '{"status":"running"}'
        WHERE context_id = ${scope.contextId} AND scope_key = ${'project:["laptop","project-a"]'}
      `;
      const invalid = yield* Effect.flip(store.get(scope, runningRun.id));
      assert.instanceOf(invalid, AxisOnboardingPersistenceError);
      assert.equal((yield* store.list(otherScope)).length, 1);
    }),
  );
});

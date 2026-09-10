import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AxisOnboardingDecision,
  AxisOnboardingRun,
} from "../../../../../packages/contracts/src/axisOnboarding.ts";
import { AxisContextProjectScope } from "../../../../../packages/contracts/src/axisProjectProfile.ts";
import { CommandId } from "../../../../../packages/contracts/src/baseSchemas.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as AxisProjectProfileStore from "../projects/AxisProjectProfileStore.ts";
import * as AxisOnboardingStore from "./AxisOnboardingStore.ts";
import { applyAxisOnboardingPersistence } from "./AxisOnboardingPersistence.ts";
import Migration0064 from "../../persistence/Migrations/064_AxisOnboardingApplications.ts";
import { AxisOnboardingApplyError } from "./AxisOnboardingApply.ts";

const persistence = NodeSqliteClient.layerMemory();
const stores = Layer.effectContext(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 63 });
    yield* Migration0064;
    const profiles = yield* AxisProjectProfileStore.make.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    const runs = yield* AxisOnboardingStore.make.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    return Context.make(SqlClient.SqlClient, sql).pipe(
      Context.add(AxisProjectProfileStore.AxisProjectProfileStore, profiles),
      Context.add(AxisOnboardingStore.AxisOnboardingStore, runs),
    );
  }),
);
const layer = it.layer(Layer.provideMerge(stores, persistence));
const decodeScope = Schema.decodeUnknownSync(AxisContextProjectScope);
const decodeRun = Schema.decodeUnknownSync(AxisOnboardingRun);
const decodeDecision = Schema.decodeUnknownSync(AxisOnboardingDecision);

const scope = decodeScope({
  contextId: "company_persistence",
  project: { environmentId: "laptop", projectId: "project-a" },
});

layer("AxisOnboardingPersistence", (it) => {
  it.effect("persists the calculated sources, facts, rules, and decisions", () =>
    Effect.gen(function* () {
      const runs = yield* AxisOnboardingStore.AxisOnboardingStore;
      const profiles = yield* AxisProjectProfileStore.AxisProjectProfileStore;
      const sql = yield* SqlClient.SqlClient;
      const run = decodeRun({
        id: "onboarding-persistence",
        scope,
        execution: {
          threadId: "thread-persistence",
          turnId: "turn-persistence",
          commandId: "command-persistence",
        },
        status: "completed",
        sources: [
          { id: "source-readme", path: "README.md", kind: "manifest", status: "read", error: null },
        ],
        digests: [
          {
            id: "digest-readme",
            sourceId: "source-readme",
            algorithm: "sha256",
            value: "sha256:readme",
            observedAt: "2026-09-10T10:00:00.000Z",
          },
        ],
        facts: [
          {
            id: "fact-package-manager",
            sourceId: "source-readme",
            key: "package-manager",
            value: "bun",
            confidence: "explicit",
          },
        ],
        candidateRules: [
          {
            id: "candidate-tests",
            category: "test-policy",
            text: "Run focused tests.",
            effect: "restriction",
            sourceIds: ["source-readme"],
            factIds: ["fact-package-manager"],
          },
        ],
        conflicts: [],
        decisions: [],
        error: null,
        startedAt: "2026-09-10T09:00:00.000Z",
        finishedAt: "2026-09-10T10:01:00.000Z",
      });
      yield* runs.save(run);

      const result = yield* applyAxisOnboardingPersistence({
        scope,
        runId: run.id,
        expectedProfileRevision: 0,
        decisions: [
          decodeDecision({
            id: "decision-tests",
            candidateRuleId: "candidate-tests",
            decision: "accept",
            note: null,
          }),
        ],
        commandId: CommandId.make("command-apply-persistence"),
        decidedAt: "2026-09-10T10:02:00.000Z",
      });

      assert.equal(result.profile.revision, 1);
      assert.equal(result.profile.sources[0]?.path, "README.md");
      assert.equal(result.profile.facts[0]?.kind, "value");
      assert.equal(result.profile.rules[0]?.text, "Run focused tests.");
      assert.equal(result.profile.manualDecisions[0]?.decision, "accept");
      const persisted = yield* profiles.get(scope);
      assert.deepEqual(persisted, result.profile);
      const persistedRun = yield* runs.get(scope, run.id);
      assert.isTrue(Option.isSome(persistedRun));
      assert.deepEqual(Option.getOrThrow(persistedRun).decisions, result.run.run.decisions);

      // Invalid decisions must not write either the profile, the run, or a replay receipt.
      const acceptedDecision = result.run.run.decisions[0]!;
      for (const decisions of [[], [acceptedDecision, acceptedDecision]]) {
        const invalid = yield* Effect.flip(
          applyAxisOnboardingPersistence({
            scope,
            runId: run.id,
            expectedProfileRevision: 1,
            decisions,
            commandId: CommandId.make("command-invalid-decisions"),
            decidedAt: "2026-09-10T10:03:00.000Z",
          }),
        );
        assert.instanceOf(invalid, AxisOnboardingApplyError);
        assert.equal((invalid as AxisOnboardingApplyError).reason, "invalid_decision");
        assert.deepEqual(yield* profiles.get(scope), persisted);
        assert.deepEqual(yield* runs.get(scope, run.id), persistedRun);
        assert.deepEqual(
          yield* sql`SELECT command_id FROM axis_onboarding_applications WHERE command_id = 'command-invalid-decisions'`,
          [],
        );
      }

      const rejected = yield* applyAxisOnboardingPersistence({
        scope,
        runId: run.id,
        expectedProfileRevision: 1,
        decisions: [{ ...acceptedDecision, decision: "reject" }],
        commandId: CommandId.make("command-reject-persistence"),
        decidedAt: "2026-09-10T10:04:00.000Z",
      });
      assert.equal(rejected.profile.revision, 2);
      assert.deepEqual(rejected.invalidatedRuleIds, [result.profile.rules[0]!.id]);
      assert.deepEqual(rejected.profile.rules, []);
      assert.deepEqual(yield* profiles.get(scope), rejected.profile);
      assert.deepEqual(
        Option.getOrThrow(yield* runs.get(scope, run.id)).decisions,
        rejected.run.run.decisions,
      );
      yield* sql`UPDATE axis_project_profiles SET revision = 7 WHERE context_id = ${scope.contextId}`;

      const replay = yield* applyAxisOnboardingPersistence({
        scope,
        runId: run.id,
        expectedProfileRevision: 0,
        decisions: [
          decodeDecision({
            id: "decision-tests",
            candidateRuleId: "candidate-tests",
            decision: "accept",
            note: null,
          }),
        ],
        commandId: CommandId.make("command-apply-persistence"),
        decidedAt: "2026-09-10T11:00:00.000Z",
      });
      assert.deepEqual(replay, result);

      const conflict = yield* Effect.flip(
        applyAxisOnboardingPersistence({
          scope,
          runId: run.id,
          expectedProfileRevision: 7,
          decisions: [
            decodeDecision({
              id: "decision-tests",
              candidateRuleId: "candidate-tests",
              decision: "accept",
              note: null,
            }),
          ],
          commandId: CommandId.make("command-apply-persistence"),
          decidedAt: "2026-09-10T11:00:00.000Z",
        }),
      );
      assert.instanceOf(conflict, AxisOnboardingStore.AxisOnboardingCommandConflictError);
    }),
  );

  it.effect("rolls back profile, decisions, and ledger together", () =>
    Effect.gen(function* () {
      const rollbackScope = {
        ...scope,
        contextId: "company_persistence_rollback" as typeof scope.contextId,
      };
      const runs = yield* AxisOnboardingStore.AxisOnboardingStore;
      const profiles = yield* AxisProjectProfileStore.AxisProjectProfileStore;
      const sql = yield* SqlClient.SqlClient;
      const run = decodeRun({
        id: "onboarding-rollback",
        scope: rollbackScope,
        execution: {
          threadId: "thread-rollback",
          turnId: "turn-rollback",
          commandId: "command-rollback",
        },
        status: "completed",
        sources: [],
        digests: [],
        facts: [],
        candidateRules: [],
        conflicts: [],
        decisions: [],
        error: null,
        startedAt: "2026-09-10T09:00:00.000Z",
        finishedAt: "2026-09-10T10:01:00.000Z",
      });
      yield* runs.save(run);
      yield* sql`CREATE TRIGGER fail_onboarding_application BEFORE INSERT ON axis_onboarding_applications BEGIN SELECT RAISE(ABORT, 'forced rollback'); END`;

      const failed = yield* Effect.flip(
        applyAxisOnboardingPersistence({
          scope: rollbackScope,
          runId: run.id,
          expectedProfileRevision: 0,
          decisions: [],
          commandId: CommandId.make("command-rollback-apply"),
          decidedAt: "2026-09-10T11:00:00.000Z",
        }),
      );
      assert.isDefined(failed);
      assert.equal((yield* profiles.get(rollbackScope)).revision, 0);
      const savedRun = yield* runs.get(rollbackScope, run.id);
      assert.isTrue(Option.isSome(savedRun));
      assert.deepEqual(Option.getOrThrow(savedRun).decisions, []);
      const ledger =
        yield* sql`SELECT command_id FROM axis_onboarding_applications WHERE command_id = 'command-rollback-apply'`;
      assert.deepEqual(ledger, []);
    }),
  );
});

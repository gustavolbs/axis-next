import { assert, it } from "@effect/vitest";
import {
  AxisContextCatalogSnapshot,
  AxisContextProjectScope,
  AxisLearningEvidence,
  AxisLearningEvidenceId,
  CommandId,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import * as AxisContextCatalogStore from "../contexts/AxisContextCatalogStore.ts";
import * as AxisLearningEngine from "./AxisLearningEngine.ts";
import * as AxisLearningService from "./AxisLearningService.ts";
import * as AxisLearningStore from "./AxisLearningStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  AxisLearningAutomaticWorker,
  buildAutomaticEvidenceBatch,
  make,
} from "./AxisLearningAutomaticWorker.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "../../provider/Services/ProviderService.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";

const scope = Schema.decodeUnknownSync(AxisContextProjectScope)({
  contextId: "personal",
  project: { environmentId: "environment", projectId: "project" },
});

const catalog = Schema.decodeUnknownSync(AxisContextCatalogSnapshot)({
  revision: 0,
  updatedAt: "2026-09-11T00:00:00.000Z",
  catalog: {
    contexts: [
      {
        id: "personal",
        kind: "personal",
        name: "Personal",
        createdAt: "2026-09-10T00:00:00.000Z",
        updatedAt: "2026-09-10T00:00:00.000Z",
      },
    ],
    projectBindings: [scope],
    providerOwnerships: [],
    providerAccessGrants: [],
    capabilities: [],
    workHubSources: [],
  },
});

const evidence = (id: string, createdAt: string) =>
  Schema.decodeUnknownSync(AxisLearningEvidence)({
    id,
    provenance: {
      contextId: scope.contextId,
      scope,
      sourceKind: "thread-turn",
      sourceId: `source-${id}`,
      observedAt: createdAt,
      fingerprint: `sha256:${id}`,
    },
    summary: `Evidence ${id}`,
    createdAt,
    expiresAt: "2026-10-11T00:00:00.000Z",
  });

const makeWorkerHarness = (input: {
  readonly initialPending?: ReadonlyArray<ReturnType<typeof evidence>>;
  readonly engineAvailability?: "available" | "absent";
  readonly runtimeEvents?: ReadonlyArray<ProviderRuntimeEvent>;
}) =>
  Effect.gen(function* () {
    const pending = yield* Ref.make<ReadonlyArray<ReturnType<typeof evidence>>>(
      input.initialPending ?? [],
    );
    const recorded = yield* Ref.make<ReadonlyArray<ReturnType<typeof evidence>>>([]);
    const analyzed = yield* Deferred.make<void>();
    const runs = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
    const marked = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
    const store = {
      recordEvidence: (value: ReturnType<typeof evidence>) =>
        Ref.update(recorded, (current) => [...current, value]).pipe(
          Effect.andThen(
            Ref.update(pending, (current) =>
              current.some((item) => item.id === value.id) ? current : [...current, value],
            ),
          ),
          Effect.as(value),
        ),
      listEvidence: (_contextId: unknown, _scope: unknown) => Ref.get(pending),
      listPendingAutomaticEvidence: (_contextId: unknown, _scope: unknown) => Ref.get(pending),
      markAutomaticEvidenceAnalyzed: (
        _scope: unknown,
        ids: ReadonlyArray<AxisLearningEvidenceId>,
      ) =>
        Ref.update(marked, (current) => [...current, ids.map(String)]).pipe(
          Effect.andThen(
            Ref.update(pending, (current) => current.filter((item) => !ids.includes(item.id))),
          ),
          Effect.andThen(Deferred.succeed(analyzed, void 0)),
        ),
    } as unknown as AxisLearningStore.AxisLearningStore["Service"];

    const service = {
      requestImprovements: (request: {
        readonly evidenceIds: ReadonlyArray<AxisLearningEvidenceId>;
      }) =>
        Ref.update(runs, (current) => [...current, request.evidenceIds.map(String)]).pipe(
          Effect.as({
            id: "run",
            commandId: CommandId.make("run"),
            status: "no-change" as const,
            engine: { availability: "available" as const, engineId: "hermes" },
            proposals: [],
            reason: "No stable pattern yet.",
          }),
        ),
    } as unknown as AxisLearningService.AxisLearningService["Service"];

    const engine = {
      status: {
        availability: input.engineAvailability ?? "available",
        engineId: "hermes",
      },
      run: () => Effect.die("unused"),
    } as unknown as AxisLearningEngine.AxisLearningEngine["Service"];
    const catalogStore = {
      get: Effect.succeed(catalog),
      replace: () => Effect.die("unused"),
    } as unknown as AxisContextCatalogStore.AxisContextCatalogStore["Service"];
    const projections = {
      getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      getThreadShellById: () =>
        Effect.succeed(
          Option.some({
            projectId: "project",
            title: "Review follow-up",
            modelSelection: { instanceId: "provider", model: "model" },
          } as unknown as OrchestrationThreadShell),
        ),
      getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
    const providers = {
      streamEvents: Stream.fromIterable(input.runtimeEvents ?? []),
    } as unknown as ProviderService.ProviderService["Service"];
    const environment = {
      getEnvironmentId: Effect.succeed("environment"),
      getDescriptor: Effect.die("unused"),
    } as unknown as ServerEnvironment.ServerEnvironment["Service"];

    const worker = yield* make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(AxisLearningStore.AxisLearningStore, store),
          Layer.succeed(AxisLearningService.AxisLearningService, service),
          Layer.succeed(AxisLearningEngine.AxisLearningEngine, engine),
          Layer.succeed(AxisContextCatalogStore.AxisContextCatalogStore, catalogStore),
          Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, projections),
          Layer.succeed(ProviderService.ProviderService, providers),
          Layer.succeed(ServerEnvironment.ServerEnvironment, environment),
          ServerSettings.ServerSettingsService.layerTest(),
        ),
      ),
    );
    return { worker, pending, recorded, analyzed, runs, marked };
  });

it("prioritizes pending evidence even when the backlog is larger than one engine batch", () => {
  const pending = Array.from({ length: 40 }, (_, index) =>
    evidence(`pending-${index}`, `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
  );
  const recent = [evidence("recent", "2026-09-11T12:00:00.000Z")];
  const result = buildAutomaticEvidenceBatch(pending, recent);

  assert.lengthOf(result.pending, 32);
  assert.lengthOf(result.batch, 32);
  assert.equal(result.pending[0]?.id, "pending-0");
  assert.isFalse(result.batch.some((item) => item.id === "recent"));
});

it.effect("records an observation and drains it through automatic analysis", () =>
  Effect.gen(function* () {
    const harness = yield* makeWorkerHarness({});
    yield* harness.worker.observe(scope, {
      sourceKind: "skill",
      sourceId: "skill:review",
      summary: "The review skill was used after request changes.",
    });
    yield* Deferred.await(harness.analyzed);

    const recorded = yield* Ref.get(harness.recorded);
    const runs = yield* Ref.get(harness.runs);
    const marked = yield* Ref.get(harness.marked);
    assert.lengthOf(recorded, 1);
    assert.deepEqual(recorded[0]?.provenance.sourceKind, "skill");
    assert.lengthOf(runs, 1);
    assert.deepEqual(runs[0], ["axis-auto-" + recorded[0]!.provenance.fingerprint.slice(7)]);
    assert.deepEqual(marked, runs);
  }),
);

it.effect("replays pending evidence at startup", () =>
  Effect.gen(function* () {
    const pending = [evidence("pending", "2026-09-10T00:00:00.000Z")];
    const harness = yield* makeWorkerHarness({ initialPending: pending });
    yield* harness.worker.start();
    yield* Deferred.await(harness.analyzed);

    assert.deepEqual(yield* Ref.get(harness.runs), [["pending"]]);
    assert.deepEqual(yield* Ref.get(harness.marked), [["pending"]]);
  }),
);

it.effect("turns a completed provider event into automatic project evidence", () =>
  Effect.gen(function* () {
    const completedEvent = {
      eventId: "event-1",
      provider: "codex",
      providerInstanceId: "provider",
      threadId: "thread-1",
      createdAt: "2026-09-11T12:00:00.000Z",
      type: "turn.completed",
      payload: { state: "completed", stopReason: "end_turn" },
    } as unknown as ProviderRuntimeEvent;
    const abortedEvent = {
      eventId: "event-2",
      provider: "codex",
      providerInstanceId: "provider",
      threadId: "thread-1",
      createdAt: "2026-09-11T12:01:00.000Z",
      type: "turn.aborted",
      payload: { reason: "user interrupted" },
    } as unknown as ProviderRuntimeEvent;
    const harness = yield* makeWorkerHarness({
      runtimeEvents: [completedEvent, abortedEvent],
    });
    yield* harness.worker.start();
    yield* Deferred.await(harness.analyzed);

    const recorded = yield* Ref.get(harness.recorded);
    assert.lengthOf(recorded, 2);
    assert.deepEqual(
      recorded.map((item) => item.provenance.sourceId),
      ["provider-event:event-1", "provider-event:event-2"],
    );
    assert.isTrue(recorded.every((item) => item.provenance.sourceKind === "thread-turn"));
    assert.include(recorded[0]?.summary, "Review follow-up");
    assert.include(recorded[1]?.summary, "aborted");
  }),
);

it.effect("retains evidence while Hermes is unavailable", () =>
  Effect.gen(function* () {
    const harness = yield* makeWorkerHarness({ engineAvailability: "absent" });
    yield* harness.worker.observe(scope, {
      sourceKind: "workspace-change",
      sourceId: "workspace:file",
      summary: "A workspace file changed.",
    });
    yield* harness.worker.start();

    assert.lengthOf(yield* Ref.get(harness.recorded), 1);
    assert.lengthOf(yield* Ref.get(harness.runs), 0);
  }),
);

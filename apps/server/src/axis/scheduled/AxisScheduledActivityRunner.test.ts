import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  AxisContextCatalogSnapshot,
  AxisScheduledActivityDraft,
  AxisWorkHubCacheSnapshot,
  AxisWorkHubItemId,
  EnvironmentId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { AxisContextCatalogStore } from "../contexts/AxisContextCatalogStore.ts";
import { AxisWorkHubCacheStore } from "../workHub/AxisWorkHubCacheStore.ts";
import { layer as sourceSyncLayer } from "../workHub/AxisWorkHubSourceSync.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { ProviderDriverError } from "../../provider/Errors.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandInvariantError } from "../../orchestration/Errors.ts";
import {
  AxisScheduledActivityRunner,
  layer as runnerLayer,
  nextAxisScheduledActivityRunAt,
} from "./AxisScheduledActivityRunner.ts";
import { AxisScheduledActivityStore, layer as storeLayer } from "./AxisScheduledActivityStore.ts";

const decodeCatalog = Schema.decodeUnknownSync(AxisContextCatalogSnapshot);
const decodeDraft = Schema.decodeUnknownSync(AxisScheduledActivityDraft);
const catalog = decodeCatalog({
  revision: 0,
  updatedAt: "2026-09-05T00:00:00.000Z",
  catalog: {
    contexts: [
      {
        id: "personal",
        kind: "personal",
        name: "Personal",
        createdAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:00.000Z",
      },
      {
        id: "company_a",
        kind: "company",
        name: "Company A",
        createdAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:00.000Z",
      },
    ],
    projectBindings: [
      {
        contextId: "personal",
        project: { environmentId: "env", projectId: "personal_project" },
      },
    ],
    providerOwnerships: [
      { contextId: "personal", provider: { environmentId: "env", instanceId: "codex" } },
    ],
    providerAccessGrants: [],
    capabilities: [
      {
        id: "calendar_mcp",
        provider: { environmentId: "env", instanceId: "codex" },
        kind: "mcp",
        name: "Calendar",
        enabled: true,
        createdAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:00.000Z",
      },
      {
        id: "jira_mcp",
        provider: { environmentId: "env", instanceId: "codex" },
        kind: "mcp",
        name: "Jira",
        enabled: true,
        createdAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:00.000Z",
      },
    ],
    workHubSources: [
      {
        id: "calendar_source",
        contextId: "personal",
        provider: { environmentId: "env", instanceId: "codex" },
        capabilityId: "calendar_mcp",
        enabled: true,
        createdAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:00.000Z",
      },
      {
        id: "jira_source",
        contextId: "personal",
        provider: { environmentId: "env", instanceId: "codex" },
        capabilityId: "jira_mcp",
        enabled: true,
        createdAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:00.000Z",
      },
      {
        id: "remote_calendar_source",
        contextId: "personal",
        provider: { environmentId: "remote_env", instanceId: "codex" },
        capabilityId: "calendar_mcp",
        enabled: true,
        createdAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:00.000Z",
      },
    ],
  },
});

const replaceCache = vi.fn<AxisWorkHubCacheStore["Service"]["replace"]>(() => Effect.void);
const collectWorkHubSource = vi.fn<NonNullable<ProviderInstance["collectWorkHubSource"]>>(
  (input) =>
    input.mcpName === "Jira"
      ? Effect.fail(
          new ProviderDriverError({
            driver: "codex",
            instanceId: "codex",
            detail: "Jira unavailable",
          }),
        )
      : Effect.succeed({
          sourceId: input.sourceId,
          contextId: input.contextId,
          provider: input.provider,
          capabilityId: input.capabilityId,
          items: [
            {
              id: AxisWorkHubItemId.make(`${input.sourceId}:calendar-event:planning`),
              sourceId: input.sourceId,
              contextId: input.contextId,
              kind: "calendar-event",
              view: "calendar",
              nativeId: "planning",
              title: "Planning",
              summary: null,
              occurredAt: null,
              startsAt: "2026-09-06T12:00:00.000Z",
              endsAt: "2026-09-06T13:00:00.000Z",
              status: null,
              deepLink: null,
              meetingLink: null,
              location: null,
              updatedAt: "2026-09-05T08:00:00.000Z",
            },
          ],
          cursor: null,
          refreshedAt: "2026-09-05T08:00:00.000Z",
          expiresAt: "2026-09-05T16:00:00.000Z",
        }),
);

let cachedSnapshot: AxisWorkHubCacheSnapshot | null = null;
const freshCacheSnapshot = Schema.decodeUnknownSync(AxisWorkHubCacheSnapshot)({
  sourceId: "calendar_source",
  contextId: "personal",
  provider: { environmentId: "env", instanceId: "codex" },
  capabilityId: "calendar_mcp",
  items: [],
  cursor: null,
  refreshedAt: "2026-09-05T07:00:00.000Z",
  expiresAt: "2026-09-05T15:00:00.000Z",
});

const persistence = SqlitePersistenceMemory;
const activityStore = storeLayer.pipe(Layer.provide(persistence));
const dispatchedCommands: OrchestrationCommand[] = [];
let rejectTurnStart = false;
const dependencies = Layer.mergeAll(
  Layer.mock(AxisContextCatalogStore)({ get: Effect.succeed(catalog) }),
  Layer.mock(AxisWorkHubCacheStore)({
    get: () => Effect.succeed(cachedSnapshot),
    list: Effect.succeed([]),
    replace: replaceCache,
    remove: () => Effect.void,
  }),
  Layer.mock(ProviderInstanceRegistry)({
    getInstance: () =>
      Effect.succeed({
        instanceId: "codex",
        driverKind: "codex",
        enabled: true,
        collectWorkHubSource,
      } as unknown as ProviderInstance),
    listInstances: Effect.succeed([]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
  }),
  Layer.mock(ServerEnvironment)({
    getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
  }),
  Layer.mock(OrchestrationEngineService)({
    dispatch: (command) => {
      dispatchedCommands.push(command);
      if (rejectTurnStart && command.type === "thread.turn.start") {
        return Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "rejected for test",
          }),
        );
      }
      return Effect.succeed({ sequence: dispatchedCommands.length });
    },
  }),
  Layer.mock(ProjectionSnapshotQuery)({
    getProjectShellById: (projectId) =>
      Effect.succeed(
        projectId === "personal_project"
          ? Option.some({ id: projectId, workspaceRoot: "/workspace" } as never)
          : Option.none(),
      ),
  }),
  activityStore,
);
const sourceSync = sourceSyncLayer.pipe(Layer.provide(dependencies));
const runner = runnerLayer.pipe(Layer.provide(sourceSync), Layer.provide(dependencies));
const testLayer = Layer.mergeAll(persistence, activityStore, runner);
const layer = it.layer(testLayer);

it("calculates interval and timezone-aware weekly occurrences", () => {
  assert.equal(
    nextAxisScheduledActivityRunAt(
      { kind: "interval", everyMinutes: 60, anchorAt: "2026-09-05T08:00:00.000Z" },
      Date.parse("2026-09-05T08:00:00.000Z"),
    ),
    "2026-09-05T09:00:00.000Z",
  );
  assert.equal(
    nextAxisScheduledActivityRunAt(
      { kind: "weekly", daysOfWeek: [1], localTime: "09:00", timezone: "America/Fortaleza" },
      Date.parse("2026-09-07T11:59:00.000Z"),
    ),
    "2026-09-07T12:00:00.000Z",
  );
});

layer("AxisScheduledActivityRunner", (it) => {
  it.effect("rejects cross-context sources", () =>
    Effect.gen(function* () {
      const service = yield* AxisScheduledActivityRunner;
      const error = yield* service
        .create(
          decodeDraft({
            id: "invalid_company_sync",
            name: "Invalid company sync",
            contextId: "company_a",
            action: { kind: "workHubSync", sourceIds: ["calendar_source"] },
            schedule: {
              kind: "interval",
              everyMinutes: 60,
              anchorAt: "2026-09-05T08:00:00.000Z",
            },
          }),
        )
        .pipe(Effect.flip);
      assert.equal(error._tag, "AxisScheduledActivityValidationError");
    }),
  );

  it.effect("rejects sources owned by another environment", () =>
    Effect.gen(function* () {
      const service = yield* AxisScheduledActivityRunner;
      const error = yield* service
        .create(
          decodeDraft({
            id: "invalid_remote_sync",
            name: "Invalid remote sync",
            contextId: "personal",
            action: { kind: "workHubSync", sourceIds: ["remote_calendar_source"] },
            schedule: {
              kind: "interval",
              everyMinutes: 60,
              anchorAt: "2026-09-05T08:00:00.000Z",
            },
          }),
        )
        .pipe(Effect.flip);
      assert.equal(error._tag, "AxisScheduledActivityValidationError");
      if (error._tag === "AxisScheduledActivityValidationError") {
        assert.match(error.message, /another environment/);
      }
    }),
  );

  it.effect("rejects agent work outside the context Project binding", () =>
    Effect.gen(function* () {
      const service = yield* AxisScheduledActivityRunner;
      const error = yield* service
        .create(
          decodeDraft({
            id: "invalid_agent_project",
            name: "Invalid agent Project",
            contextId: "personal",
            action: {
              kind: "agentTurn",
              project: { environmentId: "env", projectId: "another_project" },
              provider: { environmentId: "env", instanceId: "codex" },
              model: "gpt-5.6-sol",
              title: "Scheduled work",
              prompt: "Do the work.",
            },
            schedule: {
              kind: "interval",
              everyMinutes: 60,
              anchorAt: "2026-09-05T08:00:00.000Z",
            },
          }),
        )
        .pipe(Effect.flip);
      assert.equal(error._tag, "AxisScheduledActivityValidationError");
      if (error._tag === "AxisScheduledActivityValidationError") {
        assert.match(error.message, /not bound/);
      }
    }),
  );

  it.effect("creates a T3 Thread and starts its first turn through orchestration", () =>
    Effect.gen(function* () {
      dispatchedCommands.length = 0;
      rejectTurnStart = false;
      yield* TestClock.setTime(Date.parse("2026-09-05T07:00:00.000Z"));
      const service = yield* AxisScheduledActivityRunner;
      const created = yield* service.create(
        decodeDraft({
          id: "daily_agent_brief",
          name: "Daily agent brief",
          contextId: "personal",
          action: {
            kind: "agentTurn",
            project: { environmentId: "env", projectId: "personal_project" },
            provider: { environmentId: "env", instanceId: "codex" },
            model: "gpt-5.6-sol",
            title: "Daily brief",
            prompt: "Review my work and prepare a brief.",
            runtimeMode: "approval-required",
            interactionMode: "default",
          },
          schedule: {
            kind: "interval",
            everyMinutes: 480,
            anchorAt: "2026-09-05T08:00:00.000Z",
          },
        }),
      );

      const run = yield* service.runNow(created.id);
      assert.equal(run.status, "succeeded");
      assert.isNotNull(run.threadId);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.create", "thread.turn.start"],
      );
      const create = dispatchedCommands[0];
      const start = dispatchedCommands[1];
      assert.equal(
        create?.type === "thread.create" ? String(create.projectId) : null,
        "personal_project",
      );
      assert.equal(
        create?.type === "thread.create" ? String(create.modelSelection.instanceId) : null,
        "codex",
      );
      assert.equal(
        start?.type === "thread.turn.start" && start.message.text,
        "Review my work and prepare a brief.",
      );
      assert.equal(start?.type === "thread.turn.start" && start.threadId, run.threadId);
      assert.deepEqual(run.sourceResults, []);
    }),
  );

  it.effect("deletes a newly created Thread when its first turn is rejected", () =>
    Effect.gen(function* () {
      dispatchedCommands.length = 0;
      rejectTurnStart = true;
      const service = yield* AxisScheduledActivityRunner;
      const created = yield* service.create(
        decodeDraft({
          id: "failing_agent_brief",
          name: "Failing agent brief",
          contextId: "personal",
          action: {
            kind: "agentTurn",
            project: { environmentId: "env", projectId: "personal_project" },
            provider: { environmentId: "env", instanceId: "codex" },
            model: "gpt-5.6-sol",
            title: "Failing brief",
            prompt: "Start work.",
          },
          schedule: {
            kind: "interval",
            everyMinutes: 480,
            anchorAt: "2026-09-05T08:00:00.000Z",
          },
        }),
      );

      const run = yield* service.runNow(created.id);
      assert.equal(run.status, "failed");
      assert.isNull(run.threadId);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.create", "thread.turn.start", "thread.delete"],
      );
      rejectTurnStart = false;
    }),
  );

  it.effect("skips fresh scheduled caches while Run now forces collection", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-05T07:00:00.000Z"));
      collectWorkHubSource.mockClear();
      cachedSnapshot = freshCacheSnapshot;
      const service = yield* AxisScheduledActivityRunner;
      const created = yield* service.create(
        decodeDraft({
          id: "fresh_cache_sync",
          name: "Fresh cache sync",
          contextId: "personal",
          action: { kind: "workHubSync", sourceIds: ["calendar_source"] },
          schedule: {
            kind: "interval",
            everyMinutes: 60,
            anchorAt: "2026-09-05T08:00:00.000Z",
          },
        }),
      );

      yield* TestClock.adjust("1 hour");
      yield* service.tick;
      const scheduled = (yield* service.listRuns(created.id, 20))[0]!;
      assert.equal(scheduled.status, "succeeded");
      assert.equal(scheduled.sourceResults[0]?.status, "skipped");
      assert.match(scheduled.sourceResults[0]?.message ?? "", /still fresh/);
      assert.equal(collectWorkHubSource.mock.calls.length, 0);

      yield* service.runNow(created.id);
      assert.equal(collectWorkHubSource.mock.calls.length, 1);
      cachedSnapshot = null;
    }),
  );

  it.effect("runs due and manual activities with isolated source failures and history", () =>
    Effect.gen(function* () {
      replaceCache.mockClear();
      cachedSnapshot = null;
      yield* TestClock.setTime(Date.parse("2026-09-05T07:00:00.000Z"));
      const service = yield* AxisScheduledActivityRunner;
      const store = yield* AxisScheduledActivityStore;
      const created = yield* service.create(
        decodeDraft({
          id: "workday_sync",
          name: "Workday sync",
          contextId: "personal",
          action: { kind: "workHubSync", sourceIds: ["calendar_source", "jira_source"] },
          schedule: {
            kind: "interval",
            everyMinutes: 60,
            anchorAt: "2026-09-05T08:00:00.000Z",
          },
        }),
      );
      assert.equal(created.nextRunAt, "2026-09-05T08:00:00.000Z");

      yield* TestClock.adjust("1 hour");
      yield* service.tick;

      const afterTick = yield* store.get(created.id);
      assert.equal(afterTick.lastRunStatus, "partial");
      assert.equal(replaceCache.mock.calls.length, 1);
      const scheduledRuns = yield* service.listRuns(created.id, 20);
      assert.equal(scheduledRuns[0]?.trigger, "scheduled");
      assert.deepEqual(
        scheduledRuns[0]?.sourceResults.map(({ status }) => status),
        ["succeeded", "failed"],
      );

      const manual = yield* service.runNow(created.id);
      assert.equal(manual.status, "partial");
      assert.equal((yield* service.listRuns(created.id, 20)).length, 2);
    }),
  );
});

// @effect-diagnostics globalErrorInEffectFailure:off
import { assert, it } from "@effect/vitest";
import {
  AxisContextId,
  AxisContextProjectScope,
  AxisTaskConflictError,
  AxisTaskId,
  AxisTaskSource,
  AxisWorkHubCachedItem,
  AxisWorkHubSourceId,
  CommandId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type AxisWorkHubCacheSnapshot,
  type AxisWorkHubSourceStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { AxisTaskStore } from "./AxisTaskStore.ts";
import { AxisTaskIntakeService, layer as intakeLayer } from "./AxisTaskIntake.ts";
import { AxisProjectScope } from "../projects/AxisProjectScope.ts";
import { AxisWorkHubCacheStore } from "../workHub/AxisWorkHubCacheStore.ts";

const scope = Schema.decodeUnknownSync(AxisContextProjectScope)({
  contextId: "company",
  project: { environmentId: "env", projectId: "project" },
});
const caller = {
  environmentId: EnvironmentId.make("env"),
  contextId: AxisContextId.make("company"),
};

const now = "2026-09-11T10:00:00.000Z";

const fakeTaskStore = (_existing?: { id: AxisTaskId; threadId: ThreadId }) => {
  const service: AxisTaskStore["Service"] = {
    get: () => Effect.succeed(Option.none()),
    list: () => Effect.succeed([]),
    create: (task, _commandId) =>
      Effect.succeed({
        ...task,
        id: task.id,
        revision: 0,
      }),
    update: (mutation) => Effect.succeed(mutation.task),
    pause: (_input) => Effect.fail(new AxisTaskConflictError({ taskId: _input.taskId })),
    reopen: (_input) => Effect.fail(new AxisTaskConflictError({ taskId: _input.taskId })),
    unlinkSource: (_input) => Effect.fail(new AxisTaskConflictError({ taskId: _input.taskId })),
    listLifecycle: () => Effect.succeed([]),
  };
  return Layer.succeed(AxisTaskStore, service);
};

const emptyCacheStore = Layer.succeed(AxisWorkHubCacheStore, {
  get: () => Effect.succeed(null),
  list: () => Effect.succeed([]),
  listStatuses: () => Effect.succeed([]),
  replace: () => Effect.void,
  recordFailure: () => Effect.void,
  remove: () => Effect.void,
} as unknown as AxisWorkHubCacheStore["Service"]);

const jiraItem = (): AxisWorkHubCachedItem =>
  Schema.decodeUnknownSync(AxisWorkHubCachedItem)({
    id: "wh-item-1",
    sourceId: AxisWorkHubSourceId.make("jira-source"),
    contextId: "company",
    kind: "assigned-work-item",
    view: "board",
    nativeId: "AX-42",
    title: "Cover malformed input handling",
    summary: null,
    occurredAt: null,
    startsAt: null,
    endsAt: null,
    allDay: false,
    startDate: null,
    endDate: null,
    sourceTimeZone: null,
    calendar: null,
    organizer: null,
    participants: [],
    responseStatus: null,
    recurrence: null,
    cancelled: false,
    status: null,
    statusMapping: null,
    assignee: null,
    priority: null,
    dueDate: null,
    labels: [],
    project: null,
    sourceUpdatedAt: null,
    deepLink: "https://company.atlassian.net/browse/AX-42",
    meetingLink: null,
    location: null,
    updatedAt: now,
  });

const jiraSnapshot = (): AxisWorkHubCacheSnapshot => ({
  sourceId: AxisWorkHubSourceId.make("jira-source"),
  contextId: AxisContextId.make("company"),
  provider: {
    environmentId: EnvironmentId.make("env"),
    instanceId: ProviderInstanceId.make("codex"),
  },
  capabilityId: "jira" as never,
  items: [jiraItem()],
  cursor: null,
  refreshedAt: now,
  expiresAt: "2026-09-11T14:00:00.000Z",
});

const buildCacheStore = (snapshot: AxisWorkHubCacheSnapshot | null) =>
  Layer.succeed(AxisWorkHubCacheStore, {
    get: () => Effect.succeed(snapshot),
    list: () => Effect.succeed(snapshot === null ? [] : [snapshot]),
    listStatuses: () => Effect.succeed([]),
    replace: () => Effect.void,
    recordFailure: () => Effect.void,
    remove: () => Effect.void,
  } as unknown as AxisWorkHubCacheStore["Service"]);

const buildMissingSnapshotCacheStore = () => {
  const service: AxisWorkHubCacheStore["Service"] = {
    get: (sourceId) =>
      sourceId === AxisWorkHubSourceId.make("missing-source")
        ? Effect.succeed(null)
        : Effect.succeed(jiraSnapshot()),
    list: Effect.succeed<ReadonlyArray<AxisWorkHubCacheSnapshot>>([]),
    listStatuses: Effect.succeed<ReadonlyArray<AxisWorkHubSourceStatus>>([]),
    replace: () => Effect.void,
    recordFailure: () => Effect.void,
    remove: () => Effect.void,
  };
  return Layer.succeed(AxisWorkHubCacheStore, service);
};

const authorizedScope = Layer.succeed(AxisProjectScope, {
  resolveProject: () => Effect.void,
  resolve: () => Effect.void,
} as unknown as AxisProjectScope["Service"]);

const unauthorizedScope = Layer.succeed(AxisProjectScope, {
  resolveProject: () => Effect.fail(new Error("denied")),
  resolve: () => Effect.fail(new Error("denied")),
} as unknown as AxisProjectScope["Service"]);

const buildLayer = (
  cache: Layer.Layer<AxisWorkHubCacheStore>,
  taskStoreLayer: Layer.Layer<AxisTaskStore> = fakeTaskStore(),
  scopeLayer: Layer.Layer<AxisProjectScope> = authorizedScope,
) => intakeLayer.pipe(Layer.provide(Layer.mergeAll(cache, taskStoreLayer, scopeLayer)));

const baseRequest = {
  scope,
  threadId: ThreadId.make("thread-1"),
  commandId: CommandId.make("command-intake"),
  title: "Cover malformed input handling",
  acceptanceCriteria: [{ id: "step-1", text: "Parser returns a typed error." }],
  workflowVersion: "v1",
  steps: [{ id: "step-1", skillId: "intake" }],
};

it.layer(buildLayer(emptyCacheStore))("AxisTaskIntake with local source", (it) => {
  it.effect("creates a task with a local source label", () =>
    Effect.gen(function* () {
      const service = yield* AxisTaskIntakeService;
      const result = yield* service.intake(caller, {
        ...baseRequest,
        source: { kind: "local-text", label: "manual note" },
      });
      assert.equal(result.task.title, "Cover malformed input handling");
      assert.equal(result.task.source?.kind, "local");
      assert.equal(
        result.task.source && result.task.source.kind === "local"
          ? result.task.source.label
          : undefined,
        "manual note",
      );
      assert.equal(result.task.status, "active");
      assert.equal(result.task.revision, 0);
    }),
  );

  it.effect("does not require a tracker for local text", () =>
    Effect.gen(function* () {
      const service = yield* AxisTaskIntakeService;
      const result = yield* service.intake(caller, {
        ...baseRequest,
        source: { kind: "local-text", label: "design review" },
      });
      assert.equal(result.task.source?.kind, "local");
    }),
  );
});

it.layer(buildLayer(buildCacheStore(jiraSnapshot())))(
  "AxisTaskIntake with Work Hub Jira item",
  (it) => {
    it.effect("maps a Jira work hub item to the Jira source kind and key", () =>
      Effect.gen(function* () {
        const service = yield* AxisTaskIntakeService;
        const result = yield* service.intake(caller, {
          ...baseRequest,
          source: {
            kind: "work-hub-item",
            sourceId: AxisWorkHubSourceId.make("jira-source"),
            nativeId: "AX-42",
          },
        });
        assert.equal(result.task.source?.kind, "jira");
        assert.equal(
          result.task.source && result.task.source.kind === "jira"
            ? result.task.source.issueKey
            : undefined,
          "AX-42",
        );
        assert.equal(result.workHubItem !== null, true);
      }),
    );

    it.effect("diagnoses ambiguous mappings when the native id is missing", () =>
      Effect.gen(function* () {
        const service = yield* AxisTaskIntakeService;
        const error = yield* Effect.flip(
          service.intake(caller, {
            ...baseRequest,
            source: {
              kind: "work-hub-item",
              sourceId: AxisWorkHubSourceId.make("jira-source"),
              nativeId: "AX-99",
            },
          }),
        );
        assert.equal(error._tag, "AxisTaskIntakeError");
        assert.equal((error as { reason: string }).reason, "ambiguous_mapping");
      }),
    );
  },
);

it.layer(buildLayer(buildMissingSnapshotCacheStore()))("AxisTaskIntake missing snapshot", (it) => {
  it.effect("diagnoses ambiguous mappings when the snapshot is missing", () =>
    Effect.gen(function* () {
      const service = yield* AxisTaskIntakeService;
      const error = yield* Effect.flip(
        service.intake(caller, {
          ...baseRequest,
          source: {
            kind: "work-hub-item",
            sourceId: AxisWorkHubSourceId.make("missing-source"),
            nativeId: "AX-42",
          },
        }),
      );
      assert.equal(error._tag, "AxisTaskIntakeError");
      assert.equal((error as { reason: string }).reason, "ambiguous_mapping");
    }),
  );
});

it.layer(buildLayer(emptyCacheStore, fakeTaskStore(), unauthorizedScope))(
  "AxisTaskIntake authorization",
  (it) => {
    it.effect("rejects unauthorized callers", () =>
      Effect.gen(function* () {
        const service = yield* AxisTaskIntakeService;
        const error = yield* Effect.flip(
          service.intake(caller, {
            ...baseRequest,
            source: { kind: "local-text", label: "manual" },
          }),
        );
        assert.equal(error._tag, "AxisTaskIntakeError");
        assert.equal((error as { reason: string }).reason, "scope_denied");
      }),
    );
  },
);

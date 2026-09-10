import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { AxisContextProjectScope } from "../../../../../packages/contracts/src/axisProjectProfile.ts";
import type { AxisProjectProfile } from "../../../../../packages/contracts/src/axisProjectProfile.ts";
import {
  AxisOnboardingRun,
  AxisOnboardingRunId,
} from "../../../../../packages/contracts/src/axisOnboarding.ts";
import type { AxisOnboardingRun as AxisOnboardingRunType } from "../../../../../packages/contracts/src/axisOnboarding.ts";
import { CommandId, ThreadId, TurnId } from "../../../../../packages/contracts/src/baseSchemas.ts";
import * as AxisOnboardingService from "./AxisOnboardingService.ts";
import { AxisOnboardingApplyError } from "./AxisOnboardingApply.ts";
import { AxisOnboardingStore } from "./AxisOnboardingStore.ts";
import * as AxisProjectSources from "./AxisProjectSources.ts";
import { AxisProjectProfileStore } from "../projects/AxisProjectProfileStore.ts";

const decodeScope = Schema.decodeUnknownSync(AxisContextProjectScope);
const scope = decodeScope({
  contextId: "personal",
  project: { environmentId: "environment", projectId: "project" },
});
const profile: AxisProjectProfile = {
  scope,
  revision: 0,
  sources: [],
  facts: [],
  rules: [],
  manualDecisions: [],
  workflow: [],
  tokenEfficiencyPolicies: [],
  updatedAt: "2026-09-10T00:00:00.000Z",
};
const startInput = {
  scope,
  execution: {
    threadId: ThreadId.make("thread-onboarding"),
    turnId: TurnId.make("turn-onboarding"),
    commandId: CommandId.make("command-onboarding"),
  },
} as const;

const completedRun = Schema.decodeUnknownSync(AxisOnboardingRun)({
  id: "onboarding-persisted",
  scope,
  execution: startInput.execution,
  status: "completed",
  sources: [],
  digests: [],
  facts: [],
  candidateRules: [],
  conflicts: [],
  decisions: [],
  error: null,
  startedAt: "2026-09-10T00:00:00.000Z",
  finishedAt: "2026-09-10T00:01:00.000Z",
});

const cancelledRun = Schema.decodeUnknownSync(AxisOnboardingRun)({
  id: "onboarding-cancelled",
  scope,
  execution: startInput.execution,
  status: "cancelled",
  sources: [],
  digests: [],
  facts: [],
  candidateRules: [],
  conflicts: [],
  decisions: [],
  error: null,
  startedAt: "2026-09-10T00:00:00.000Z",
  finishedAt: "2026-09-10T00:01:00.000Z",
});

const sourceInventory: AxisProjectSources.AxisProjectSourcesResult = {
  workspaceRoot: "/project",
  sources: [
    {
      path: "package.json",
      kind: "manifest",
      status: "read",
      content: '{"scripts":{"test":"vp test run"}}',
      byteLength: 39,
      truncated: false,
      error: null,
    },
  ],
  fileCount: 1,
  byteCount: 39,
  truncated: false,
};

const storeLayer = (overrides: Partial<AxisOnboardingStore["Service"]> = {}) =>
  Layer.mock(AxisOnboardingStore)({
    list: () => Effect.succeed([]),
    get: () => Effect.succeed(Option.none()),
    save: () => Effect.void,
    start: (input) => Effect.succeed("run" in input ? input.run : input),
    cancel: (_scope, input) => Effect.die(`cancel ${input.runId}`),
    retry: (_scope, input) => Effect.die(`retry ${input.runId}`),
    ...overrides,
  });

const profileLayer = (overrides: Partial<AxisProjectProfileStore["Service"]> = {}) =>
  Layer.mock(AxisProjectProfileStore)({
    get: () => Effect.succeed(profile),
    replace: () => Effect.succeed(profile),
    resetOverride: () => Effect.succeed(profile),
    ...overrides,
  });

const sourceLayer = () =>
  Layer.mock(AxisProjectSources.AxisProjectSources)({
    collect: () => Effect.succeed(sourceInventory),
  });

const serviceWith = (
  store: Layer.Layer<AxisOnboardingStore, never, never> = storeLayer(),
  profiles: Layer.Layer<AxisProjectProfileStore, never, never> = profileLayer(),
  sources: Layer.Layer<AxisProjectSources.AxisProjectSources, never, never> = sourceLayer(),
) => AxisOnboardingService.make.pipe(Effect.provide(Layer.mergeAll(store, profiles, sources)));

describe("AxisOnboardingService", () => {
  it.effect("starts once per scoped T3 command and derives collecting progress", () =>
    Effect.gen(function* () {
      let starts = 0;
      const run = yield* serviceWith(
        storeLayer({
          start: (input) => {
            starts += 1;
            return Effect.succeed("run" in input ? input.run : input);
          },
        }),
      ).pipe(Effect.flatMap((service) => service.start(startInput)));

      expect(run.run.status).toBe("running");
      expect(run.run.execution.commandId).toBe(startInput.execution.commandId);
      expect(run.progress.stage).toBe("collecting");
      expect(run.progress.completedSteps).toBe(0);
      expect(starts).toBe(1);
    }),
  );

  it.effect("collects non-empty project data and persists a terminal completed run", () =>
    Effect.gen(function* () {
      const collected = Deferred.makeUnsafe<void>();
      const allowAnalysis = Deferred.makeUnsafe<void>();
      const terminal = Deferred.makeUnsafe<void>();
      let stored: AxisOnboardingRunType | undefined;
      const saved: AxisOnboardingRunType[] = [];
      const service = yield* serviceWith(
        storeLayer({
          get: () => Effect.succeed(stored === undefined ? Option.none() : Option.some(stored)),
          start: (input) =>
            Effect.sync(() => {
              stored = "run" in input ? input.run : input;
              return stored;
            }),
          save: (run) =>
            Effect.gen(function* () {
              stored = run;
              saved.push(run);
              if (run.status === "running" && run.facts.length > 0) {
                yield* Deferred.succeed(collected, undefined);
                yield* Deferred.await(allowAnalysis);
              }
              if (run.status === "completed") {
                yield* Deferred.succeed(terminal, undefined);
              }
            }),
        }),
      );

      const started = yield* service.start(startInput);
      expect(started.progress.stage).toBe("collecting");
      yield* Deferred.await(collected);

      const duringAnalysis = yield* service.get(scope, started.run.id);
      expect(duringAnalysis.run.sources).toHaveLength(1);
      expect(duringAnalysis.run.facts.length).toBeGreaterThan(0);
      expect(duringAnalysis.progress.stage).toBe("analyzing");
      expect(duringAnalysis.progress.completedSteps).toBe(2);

      yield* Deferred.succeed(allowAnalysis, undefined);
      yield* Deferred.await(terminal);
      const finished = yield* service.get(scope, started.run.id);
      expect(finished.run.status).toBe("completed");
      expect(finished.progress.stage).toBe("completed");
      expect(saved.some((run) => run.status === "running" && run.facts.length > 0)).toBe(true);
      expect(saved.at(-1)?.status).toBe("completed");
    }),
  );

  it.effect("returns a persisted run after reload and does not duplicate an accepted start", () =>
    Effect.gen(function* () {
      const result = yield* serviceWith(
        storeLayer({
          get: () => Effect.succeed(Option.some(completedRun)),
          start: () => Effect.die("must not create a duplicate"),
        }),
      ).pipe(Effect.flatMap((service) => service.get(scope, completedRun.id)));

      expect(result.run.id).toBe(AxisOnboardingRunId.make("onboarding-persisted"));
      expect(result.progress.stage).toBe("completed");
    }),
  );

  it.effect("delegates cancellation and retry as explicit scoped commands", () =>
    Effect.gen(function* () {
      const retried: AxisOnboardingRunType = {
        ...cancelledRun,
        status: "running",
        error: null,
        finishedAt: null,
      };
      const service = yield* serviceWith(
        storeLayer({
          cancel: () => Effect.succeed(cancelledRun),
          retry: () => Effect.succeed(retried),
          save: () => Effect.void,
        }),
      );
      const cancelResult = yield* service.cancel(scope, {
        runId: cancelledRun.id,
        commandId: CommandId.make("command-cancel"),
        reason: "Stop onboarding",
      });
      const retryResult = yield* service.retry(scope, {
        runId: cancelledRun.id,
        commandId: CommandId.make("command-retry"),
      });

      expect(cancelResult.run.status).toBe("cancelled");
      expect(cancelResult.progress.stage).toBe("cancelled");
      expect(retryResult.run.status).toBe("running");
      expect(retryResult.progress.stage).toBe("collecting");
    }),
  );

  it.effect("refuses apply for a cancelled or incomplete run", () =>
    Effect.gen(function* () {
      const service = yield* serviceWith(
        storeLayer({ get: () => Effect.succeed(Option.some(cancelledRun)) }),
      );
      const error = yield* service
        .apply({
          scope,
          runId: cancelledRun.id,
          expectedProfileRevision: 0,
          decisions: [],
          commandId: CommandId.make("command-apply"),
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(AxisOnboardingApplyError);
      if (error instanceof AxisOnboardingApplyError) {
        expect(error.reason).toBe("run_not_complete");
      }
    }),
  );
});

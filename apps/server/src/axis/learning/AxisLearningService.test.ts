import { describe, expect, it } from "@effect/vitest";
import {
  AxisContextProjectScope,
  AxisLearningEvidence,
  AxisLearningProposal,
  AxisLearningSnapshot,
  AxisProjectProfile,
  CommandId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { AxisLearningEngine } from "./AxisLearningEngine.ts";
import { AxisLearningEngineCandidateProposal } from "../../../../../packages/contracts/src/axisLearningEngine.ts";
import * as AxisLearningService from "./AxisLearningService.ts";
import { AxisLearningStore } from "./AxisLearningStore.ts";
import { AxisProjectProfileStore } from "../projects/AxisProjectProfileStore.ts";

const decodeCandidate = Schema.decodeUnknownSync(AxisLearningEngineCandidateProposal);
const decodeProposal = Schema.decodeUnknownSync(AxisLearningProposal);

const scope = Schema.decodeUnknownSync(AxisContextProjectScope)({
  contextId: "personal",
  project: { environmentId: "environment", projectId: "project" },
});
const evidence = Schema.decodeUnknownSync(AxisLearningEvidence)({
  id: "evidence-1",
  provenance: {
    contextId: "personal",
    scope,
    sourceKind: "user-correction",
    sourceId: "turn-1",
    observedAt: "2026-09-10T00:00:00.000Z",
    fingerprint: "fingerprint-1",
  },
  summary: "The project uses the focused test command.",
  createdAt: "2026-09-10T00:00:00.000Z",
  expiresAt: "2026-09-11T00:00:00.000Z",
});
const profile = Schema.decodeUnknownSync(AxisProjectProfile)({
  scope,
  revision: 0,
  sources: [],
  facts: [],
  rules: [],
  manualDecisions: [],
  workflow: [],
  tokenEfficiencyPolicies: [],
  updatedAt: "2026-09-10T00:00:00.000Z",
});
const snapshot = Schema.decodeUnknownSync(AxisLearningSnapshot)({
  contextId: "personal",
  evidence: [evidence],
  proposals: [],
  versions: [],
  activeVersions: [],
  activeStates: [],
  lifecycle: [],
});
const input = {
  scope,
  evidenceIds: [evidence.id],
  commandId: CommandId.make("command-learning-1"),
  deadlineMs: 10_000,
} as const;

const storeLayer = (overrides: Partial<AxisLearningStore["Service"]> = {}) =>
  Layer.mock(AxisLearningStore)({
    recordEvidence: () => Effect.succeed(evidence),
    listEvidence: () => Effect.succeed([evidence]),
    listPendingAutomaticEvidence: () => Effect.succeed([evidence]),
    markAutomaticEvidenceAnalyzed: () => Effect.void,
    purgeExpiredEvidence: () => Effect.succeed(0),
    createProposal: () => Effect.die("not used"),
    getProposal: () => Effect.die("not used"),
    submitForReview: () => Effect.die("not used"),
    approve: () => Effect.die("not used"),
    reject: () => Effect.die("not used"),
    activate: () => Effect.die("not used"),
    rollback: () => Effect.die("not used"),
    deactivate: () => Effect.die("not used"),
    getActive: () => Effect.succeed(Option.none()),
    listLifecycle: () => Effect.succeed([]),
    getSnapshot: () => Effect.succeed(snapshot),
    ...overrides,
  });

const profileLayer = Layer.mock(AxisProjectProfileStore)({
  get: () => Effect.succeed(profile),
  replace: () => Effect.succeed(profile),
  resetOverride: () => Effect.succeed(profile),
});

const runService = (
  engine: AxisLearningEngine["Service"],
  store: Layer.Layer<AxisLearningStore, never, never> = storeLayer(),
  inputValue: typeof input = input,
) =>
  AxisLearningService.make.pipe(
    Effect.provide(Layer.mergeAll(Layer.succeed(AxisLearningEngine, engine), store, profileLayer)),
    Effect.flatMap((service) => service.requestImprovements(inputValue)),
  );

describe("AxisLearningService", () => {
  it.effect("returns an observable unavailable run without inventing a proposal", () =>
    Effect.gen(function* () {
      const result = yield* runService({
        status: { availability: "absent", message: "Hermes is not configured." },
        run: () =>
          Effect.succeed({
            status: "unavailable",
            availability: "absent",
            message: "Hermes is not configured.",
          }),
      });

      expect(result.status).toBe("unavailable");
      expect(result.proposals).toHaveLength(0);
      expect(result.reason).toContain("Hermes");
    }),
  );

  it.effect("rejects evidence IDs that are not in the requested project", () =>
    Effect.gen(function* () {
      const error = yield* runService(
        {
          status: { availability: "absent" },
          run: () =>
            Effect.succeed({ status: "unavailable", availability: "absent", message: "offline" }),
        },
        storeLayer({ listEvidence: () => Effect.succeed([]) }),
      ).pipe(Effect.flip);

      expect(error._tag).toBe("AxisLearningValidationError");
    }),
  );

  it.effect("evaluates engine candidates and submits accepted proposals for review", () =>
    Effect.gen(function* () {
      const candidate = decodeCandidate({
        contextId: "personal",
        scope,
        kind: "workflow-recommendation",
        targetKey: "test-command",
        title: "Use the focused test command",
        rationale: "The correction evidence identifies the command used by this project.",
        evidenceIds: [evidence.id],
        change: {
          op: "set-workflow-step",
          step: {
            id: "test-step",
            title: "Run tests",
            instruction: "Run the focused project test command.",
            required: true,
            order: 0,
          },
        },
      });
      const created = decodeProposal({
        id: "axis-learning-proposal-1",
        contextId: "personal",
        scope,
        kind: candidate.kind,
        targetKey: candidate.targetKey,
        title: candidate.title,
        rationale: candidate.rationale,
        evidenceIds: candidate.evidenceIds,
        change: candidate.change,
        status: "draft",
        createdAt: "2026-09-10T00:00:00.000Z",
        updatedAt: "2026-09-10T00:00:00.000Z",
        reviewedAt: null,
        reviewedBy: null,
        reviewNote: null,
      });
      const reviewed = { ...created, status: "in-review" as const };
      const createProposal = () => Effect.succeed(created);
      let submittedScope: AxisContextProjectScope | undefined;
      const submitForReview: AxisLearningStore["Service"]["submitForReview"] = (
        _id,
        lookup,
        _input,
      ) => {
        submittedScope = lookup as AxisContextProjectScope;
        return Effect.succeed(reviewed);
      };
      const result = yield* runService(
        {
          status: { availability: "available", engineId: "test-engine" },
          run: () => Effect.succeed({ status: "proposals", proposals: [candidate] }),
        },
        storeLayer({ createProposal, submitForReview }),
      );

      expect(result.status).toBe("proposals");
      expect(result.proposals).toEqual([reviewed]);
      expect(submittedScope).toEqual(scope);
    }),
  );
});

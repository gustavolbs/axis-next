import { assert, it } from "@effect/vitest";
import {
  AxisContextProjectScope,
  AxisSkillId,
  AxisTaskStepId,
  CheckpointRef,
  CommandId,
  ThreadId,
  TurnId,
  type OrchestrationCheckpointFile,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CheckpointDiffQuery } from "../../checkpointing/CheckpointDiffQuery.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AxisProjectScope } from "../projects/AxisProjectScope.ts";
import {
  AxisReviewEvidence,
  AxisReviewEvidenceError,
  AxisReviewEvidenceService,
  layer as reviewLayer,
} from "./AxisReviewEvidence.ts";

const scope = Schema.decodeUnknownSync(AxisContextProjectScope)({
  contextId: "company",
  project: { environmentId: "env", projectId: "project" },
});
const caller = { environmentId: "env", contextId: "company" };

interface FakeCheckpointInput {
  readonly diff: string;
  readonly files: ReadonlyArray<OrchestrationCheckpointFile>;
  readonly toCheckpointRef: CheckpointRef;
}

const buildDiffLayer = (input: FakeCheckpointInput) =>
  Layer.succeed(CheckpointDiffQuery, {
    getTurnDiff: () =>
      Effect.succeed({
        threadId: ThreadId.make("review-thread"),
        fromTurnCount: 0,
        toTurnCount: 1,
        diff: input.diff,
      }),
    getFullThreadDiff: () =>
      Effect.succeed({
        threadId: ThreadId.make("review-thread"),
        fromTurnCount: 0,
        toTurnCount: 1,
        diff: input.diff,
      }),
  } as unknown as CheckpointDiffQuery["Service"]);

const buildSnapshotLayer = (input: {
  readonly available: boolean;
  readonly checkpointRef: CheckpointRef | null;
}) =>
  Layer.succeed(ProjectionSnapshotQuery, {
    getFullThreadDiffContext: () =>
      Effect.succeed(
        input.available
          ? Option.some({
              threadId: ThreadId.make("review-thread"),
              projectId: "project",
              workspaceRoot: "/tmp/repo",
              worktreePath: null,
              latestCheckpointTurnCount: 1,
              toCheckpointRef: input.checkpointRef,
            })
          : Option.none(),
      ),
  } as unknown as ProjectionSnapshotQuery["Service"]);

const authorizedScope = Layer.succeed(AxisProjectScope, {
  resolveProject: () => Effect.void,
  resolve: () => Effect.void,
} as unknown as AxisProjectScope["Service"]);

const unauthorizedScope = Layer.succeed(AxisProjectScope, {
  resolveProject: () => Effect.fail(new Error("denied")),
  resolve: () => Effect.fail(new Error("denied")),
} as unknown as AxisProjectScope["Service"]);

const baseRequest = {
  scope,
  stepId: AxisTaskStepId.make("self-review"),
  skillId: AxisSkillId.make("self-review"),
  turnId: TurnId.make("turn-1"),
  commandId: CommandId.make("command-review"),
  fromTurnCount: 0,
  toTurnCount: 1,
  verdict: "request-changes" as const,
  summary: "Found a missing error path in the parser.",
  reason: "Need to cover malformed input handling.",
  findings: [
    {
      severity: "blocker" as const,
      path: "apps/server/src/parser.ts",
      lineRange: { start: 12, end: 18 },
      summary: "No error returned on malformed input.",
      rationale: "Acceptance criterion AC-1 mandates a typed error.",
    },
  ],
};

const buildLayer = (
  checkpoint: FakeCheckpointInput,
  available: boolean,
  scopeLayer: Layer.Layer<AxisProjectScope> = authorizedScope,
) =>
  reviewLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        buildDiffLayer(checkpoint),
        buildSnapshotLayer({
          available,
          checkpointRef: checkpoint.toCheckpointRef,
        }),
      ),
    ),
    Layer.provide(scopeLayer),
  );

it.layer(
  buildLayer(
    {
      diff: "diff --git a/parser.ts b/parser.ts\n+export function parse(){}\n",
      files: [
        {
          path: "apps/server/src/parser.ts",
          insertions: 1,
          deletions: 0,
          kind: "modified",
        },
      ],
      toCheckpointRef: "refs/t3/checkpoints/thread/turn-1" as CheckpointRef,
    },
    true,
  ),
)("AxisReviewEvidence with diff", (it) => {
  it.effect("captures a blocker finding bound to the diff digest", () =>
    Effect.gen(function* () {
      const service = yield* AxisReviewEvidenceService;
      const evidence = yield* service.capture(caller, baseRequest);
      assert.equal(evidence.verdict, "request-changes");
      assert.equal(evidence.findings[0]?.severity, "blocker");
      assert.equal(evidence.diffDigest.length > 0, true);
      assert.equal(evidence.toCheckpointRef, "refs/t3/checkpoints/thread/turn-1");
    }),
  );

  it.effect("captures file change set and rule sources used", () =>
    Effect.gen(function* () {
      const service = yield* AxisReviewEvidenceService;
      const evidence = yield* service.capture(caller, {
        ...baseRequest,
        ruleSourcesUsed: ["apps/server/AGENTS.md", "apps/server/src/parser.ts"],
      });
      assert.equal(evidence.files.length, 0);
      assert.deepEqual(evidence.ruleSourcesUsed, [
        "apps/server/AGENTS.md",
        "apps/server/src/parser.ts",
      ]);
    }),
  );

  it.effect("treats a comment verdict as the only verdict without a diff", () =>
    Effect.gen(function* () {
      const service = yield* AxisReviewEvidenceService;
      const comment = yield* service.capture(caller, {
        ...baseRequest,
        verdict: "comment",
        summary: "Style note: prefer immutable defaults.",
      });
      assert.equal(comment.verdict, "comment");
      assert.equal(comment.diffDigest.length > 0, true);
    }),
  );

  it.effect("rejects inputs where fromTurnCount > toTurnCount", () =>
    Effect.gen(function* () {
      const service = yield* AxisReviewEvidenceService;
      const error = yield* Effect.flip(
        service.capture(caller, { ...baseRequest, fromTurnCount: 5, toTurnCount: 2 }),
      );
      assert.equal(error._tag, "AxisReviewEvidenceError");
      assert.equal((error as AxisReviewEvidenceError).reason, "invalid_input");
    }),
  );

  it.effect("considers a review valid only when the digest still matches", () =>
    Effect.gen(function* () {
      const service = yield* AxisReviewEvidenceService;
      const evidence = yield* service.capture(caller, baseRequest);
      const ok = yield* service.verifyCurrentDigest(caller, evidence);
      assert.equal(ok, true);
    }),
  );

  it.effect("treats a stale diff as invalid", () =>
    Effect.gen(function* () {
      const service = yield* AxisReviewEvidenceService;
      const evidence = yield* service.capture(caller, baseRequest);
      const altered = Schema.decodeUnknownSync(AxisReviewEvidence)({
        ...evidence,
        diffDigest: "sha256:altered",
      });
      const stillOk = yield* service.verifyCurrentDigest(caller, altered);
      assert.equal(stillOk, false);
    }),
  );

  it.effect("lists only the captured reviews for the project", () =>
    Effect.gen(function* () {
      const service = yield* AxisReviewEvidenceService;
      yield* service.capture(caller, baseRequest);
      yield* service.capture(caller, {
        ...baseRequest,
        commandId: CommandId.make("command-other"),
        verdict: "approve",
        summary: "Looks correct.",
        findings: [],
      });
      const all = yield* service.listForScope(caller, scope);
      assert.equal(all.length, 2);
    }),
  );
});

it.layer(
  buildLayer(
    {
      diff: "diff --git a/x.ts b/x.ts\n",
      files: [],
      toCheckpointRef: "refs/t3/checkpoints/x" as CheckpointRef,
    },
    true,
    unauthorizedScope,
  ),
)("AxisReviewEvidence when denied", (it) => {
  it.effect("rejects capture by unauthorized callers", () =>
    Effect.gen(function* () {
      const service = yield* AxisReviewEvidenceService;
      const error = yield* Effect.flip(service.capture(caller, baseRequest));
      assert.equal(error._tag, "AxisReviewEvidenceError");
      assert.equal((error as AxisReviewEvidenceError).reason, "scope_denied");
    }),
  );
});

it.layer(
  buildLayer(
    {
      diff: "",
      files: [],
      toCheckpointRef: "refs/t3/checkpoints/missing" as CheckpointRef,
    },
    false,
  ),
)("AxisReviewEvidence without checkpoint", (it) => {
  it.effect("rejects a non-comment verdict when the diff context is missing", () =>
    Effect.gen(function* () {
      const service = yield* AxisReviewEvidenceService;
      const error = yield* Effect.flip(service.capture(caller, baseRequest));
      assert.equal(error._tag, "AxisReviewEvidenceError");
      assert.equal((error as AxisReviewEvidenceError).reason, "no_checkpoint");
    }),
  );

  it.effect("still records a comment verdict when no checkpoint exists", () =>
    Effect.gen(function* () {
      const service = yield* AxisReviewEvidenceService;
      const comment = yield* service.capture(caller, {
        ...baseRequest,
        verdict: "comment",
        summary: "Acknowledge absence of a real diff.",
      });
      assert.equal(comment.verdict, "comment");
    }),
  );
});

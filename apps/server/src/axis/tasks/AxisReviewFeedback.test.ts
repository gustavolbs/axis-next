import { assert, it } from "@effect/vitest";
import { AxisContextProjectScope, AxisProjectLocator } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { AxisProjectScope } from "../projects/AxisProjectScope.ts";
import { AxisReviewFeedbackService, layer as feedbackLayer } from "./AxisReviewFeedback.ts";

const scope = Schema.decodeUnknownSync(AxisContextProjectScope)({
  contextId: "company",
  project: { environmentId: "env", projectId: "project" },
});
const otherProjectScope = Schema.decodeUnknownSync(AxisContextProjectScope)({
  contextId: "company",
  project: { environmentId: "env", projectId: "other-project" },
});
const otherContextScope = Schema.decodeUnknownSync(AxisContextProjectScope)({
  contextId: "personal",
  project: { environmentId: "env", projectId: "project" },
});
const caller = { environmentId: "env", contextId: "company" };

const authorizedScope = Layer.succeed(AxisProjectScope, {
  resolveProject: () => Effect.void,
  resolve: () => Effect.void,
} as unknown as AxisProjectScope["Service"]);

const unauthorizedScope = Layer.succeed(AxisProjectScope, {
  resolveProject: () => Effect.fail(new Error("denied")),
  resolve: () => Effect.fail(new Error("denied")),
} as unknown as AxisProjectScope["Service"]);

const baseInput = {
  scope,
  pullRequestId: "PR-42",
  pullRequestUrl: "https://example.test/project/pull/42",
  sourceKind: "pull-request-comment" as const,
  threadId: "thread-1",
  decision: "accept" as const,
  rationale: "Addressed in commit abc123.",
  observedAt: "2026-09-11T10:00:00.000Z",
  comments: [
    {
      id: "comment-1",
      author: "reviewer",
      url: "https://example.test/project/pull/42#comment-1",
      body: "Need to handle malformed input.",
      path: "apps/server/src/parser.ts",
      lineRange: { start: 12, end: 18 },
      authoredAt: "2026-09-10T09:30:00.000Z",
    },
    {
      id: "comment-2",
      author: "reviewer",
      url: "https://example.test/project/pull/42#comment-2",
      body: "Add unit tests for the error path.",
      path: "apps/server/src/parser.test.ts",
      lineRange: null,
      authoredAt: "2026-09-10T09:32:00.000Z",
    },
  ],
};

const buildLayer = (scopeLayer: Layer.Layer<AxisProjectScope> = authorizedScope) =>
  feedbackLayer.pipe(Layer.provide(scopeLayer));

it.layer(buildLayer())("AxisReviewFeedback", (it) => {
  it.effect("records one evidence per comment and scopes to the project", () =>
    Effect.gen(function* () {
      const service = yield* AxisReviewFeedbackService;
      const result = yield* service.recordFeedback(caller, baseInput);
      assert.equal(result.evidence.length, 2);
      for (const evidence of result.evidence) {
        assert.equal(evidence.provenance.scope?.contextId, "company");
        assert.equal(evidence.provenance.scope?.project?.projectId, "project");
        assert.equal(evidence.provenance.sourceKind, "user-correction");
      }
    }),
  );

  it.effect("does not duplicate evidence when the same feedback is re-imported", () =>
    Effect.gen(function* () {
      const service = yield* AxisReviewFeedbackService;
      const first = yield* service.recordFeedback(caller, baseInput);
      const second = yield* service.recordFeedback(caller, baseInput);
      assert.equal(first.fingerprint, second.fingerprint);
      assert.equal(first.evidence[0]?.id, second.evidence[0]?.id);
    }),
  );

  it.effect("produces a different fingerprint when comments change", () =>
    Effect.gen(function* () {
      const service = yield* AxisReviewFeedbackService;
      const first = yield* service.recordFeedback(caller, baseInput);
      const second = yield* service.recordFeedback(caller, {
        ...baseInput,
        comments: [baseInput.comments[0]!],
      });
      assert.notEqual(first.fingerprint, second.fingerprint);
    }),
  );

  it.effect("does not share feedback between projects even when the company matches", () =>
    Effect.gen(function* () {
      const service = yield* AxisReviewFeedbackService;
      yield* service.recordFeedback(caller, baseInput);
      const otherResult = yield* service.recordFeedback(caller, {
        ...baseInput,
        scope: otherProjectScope,
      });
      assert.notEqual(otherResult.scope.project?.projectId, "project");
      assert.equal(otherResult.scope.project?.projectId, "other-project");
    }),
  );

  it.effect("treats different contexts as separate scopes", () =>
    Effect.gen(function* () {
      const service = yield* AxisReviewFeedbackService;
      const personal = yield* service.recordFeedback(caller, {
        ...baseInput,
        scope: otherContextScope,
      });
      assert.equal(personal.scope.contextId, "personal");
    }),
  );

  it.effect("preserves a project-specific decision so it is not re-proposed globally", () =>
    Effect.gen(function* () {
      const service = yield* AxisReviewFeedbackService;
      const result = yield* service.recordFeedback(caller, {
        ...baseInput,
        decision: "specific-to-this-task",
      });
      const provenance = result.evidence[0]?.provenance;
      assert.equal(provenance?.scope?.project?.projectId, "project");
    }),
  );

  it.effect("rejects an accept decision without any comments", () =>
    Effect.gen(function* () {
      const service = yield* AxisReviewFeedbackService;
      const error = yield* Effect.flip(
        service.recordFeedback(caller, {
          ...baseInput,
          comments: [],
        }),
      );
      assert.equal(error._tag, "AxisReviewFeedbackError");
      assert.equal((error as { reason: string }).reason, "no_comments");
    }),
  );

  it.effect("exposes the project scope derivation for downstream use", () =>
    Effect.gen(function* () {
      const service = yield* AxisReviewFeedbackService;
      const derived = service.scopeFor(otherProjectScope);
      assert.equal(derived.contextId, "company");
      assert.deepEqual(
        derived.project,
        Schema.decodeUnknownSync(AxisProjectLocator)(otherProjectScope.project),
      );
    }),
  );
});

it.layer(buildLayer(unauthorizedScope))("AxisReviewFeedback when denied", (it) => {
  it.effect("rejects unauthorized callers", () =>
    Effect.gen(function* () {
      const service = yield* AxisReviewFeedbackService;
      const error = yield* Effect.flip(service.recordFeedback(caller, baseInput));
      assert.equal(error._tag, "AxisReviewFeedbackError");
      assert.equal((error as { reason: string }).reason, "scope_denied");
    }),
  );
});

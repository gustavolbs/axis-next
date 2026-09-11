import { assert, it } from "@effect/vitest";
import {
  AxisContextProjectScope,
  AxisSkillId,
  AxisTaskStepId,
  CommandId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { AxisProjectScope } from "../projects/AxisProjectScope.ts";
import {
  AxisVerificationReporterService,
  layer as verificationLayer,
} from "./AxisVerificationEvidence.ts";

const scope = Schema.decodeUnknownSync(AxisContextProjectScope)({
  contextId: "company",
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
  stepId: AxisTaskStepId.make("verify-step"),
  skillId: AxisSkillId.make("verify"),
  commandId: CommandId.make("command-verify"),
  turnId: TurnId.make("turn-1"),
  kind: "command" as const,
  summary: "Ran focused unit test for the parser.",
  command: {
    command: "pnpm vitest run src/parser.test.ts",
    cwd: "apps/server",
    exitCode: 0,
    stdoutExcerpt: "ok",
  },
  coveredFiles: ["apps/server/src/parser.ts"],
  observedAt: "2026-09-11T10:00:00.000Z",
};

it.layer(verificationLayer.pipe(Layer.provide(authorizedScope)))(
  "AxisVerificationReporterService",
  (it) => {
    it.effect("records passed command evidence and reports coverage", () =>
      Effect.gen(function* () {
        const service = yield* AxisVerificationReporterService;
        const evidence = yield* service.record(caller, baseInput);
        assert.equal(evidence.status, "passed");
        assert.equal(evidence.fingerprint.length > 0, true);
        const coverage = yield* service.coverage(scope, baseInput.stepId, [
          "apps/server/src/parser.ts",
        ]);
        assert.equal(coverage, "covered");
      }),
    );

    it.effect("treats non-zero exit code as failed and refuses empty stderr", () =>
      Effect.gen(function* () {
        const service = yield* AxisVerificationReporterService;
        const failed = yield* Effect.flip(
          service.record(caller, {
            ...baseInput,
            command: {
              command: "pnpm vitest run src/parser.test.ts",
              exitCode: 1,
            },
          }),
        );
        assert.equal(failed._tag, "AxisVerificationInputError");

        const withStderr = yield* service.record(caller, {
          ...baseInput,
          command: {
            command: "pnpm vitest run src/parser.test.ts",
            exitCode: 1,
            stderrExcerpt: "1 test failed",
          },
        });
        assert.equal(withStderr.status, "failed");
      }),
    );

    it.effect("marks not-applicable only with a reason and keeps it distinct", () =>
      Effect.gen(function* () {
        const service = yield* AxisVerificationReporterService;
        const skip = yield* service.markNotApplicable(caller, {
          ...baseInput,
          reason: "Project ships without a test runner.",
        });
        assert.equal(skip.status, "not-applicable");
        assert.equal(skip.command, null);
        assert.notEqual(skip.status, "passed");

        const blocked = yield* Effect.flip(
          service.markNotApplicable(caller, {
            ...baseInput,
            reason: "  ",
          }),
        );
        assert.equal(blocked._tag, "AxisVerificationInputError");
      }),
    );

    it.effect("flags coverage as stale when covered files no longer match", () =>
      Effect.gen(function* () {
        const service = yield* AxisVerificationReporterService;
        yield* service.record(caller, {
          ...baseInput,
          command: {
            command: "pnpm vitest run src/parser.test.ts",
            exitCode: 0,
            stdoutExcerpt: "ok",
          },
          coveredFiles: ["apps/server/src/parser.ts"],
        });
        const stale = yield* service.coverage(scope, baseInput.stepId, [
          "apps/server/src/another.ts",
        ]);
        assert.equal(stale, "stale");

        const missing = yield* service.coverage(scope, AxisTaskStepId.make("never-recorded"), [
          "apps/server/src/parser.ts",
        ]);
        assert.equal(missing, "missing");
      }),
    );

    it.effect("refuses to mark a non-existent command as passed", () =>
      Effect.gen(function* () {
        const service = yield* AxisVerificationReporterService;
        const evidence = yield* service.record(caller, {
          ...baseInput,
          command: null,
        });
        assert.equal(evidence.status, "not-run");
        assert.equal(evidence.command, null);
      }),
    );

    it.effect("never accepts provider text alone as passing evidence", () =>
      Effect.gen(function* () {
        const service = yield* AxisVerificationReporterService;
        const first = yield* service.record(caller, {
          ...baseInput,
          summary: "Provider said all tests passed.",
          command: null,
        });
        assert.equal(first.status, "not-run");
        const second = yield* service.record(caller, {
          ...baseInput,
          summary: "Provider said all tests passed.",
          command: null,
        });
        assert.equal(second.fingerprint, first.fingerprint);
      }),
    );

    it.effect("does not consider absent reviews a passing grade", () =>
      Effect.gen(function* () {
        const service = yield* AxisVerificationReporterService;
        const empty = yield* service.coverage(scope, AxisTaskStepId.make("step-x"), []);
        assert.equal(empty, "missing");
      }),
    );
  },
);

it.layer(verificationLayer.pipe(Layer.provide(unauthorizedScope)))(
  "AxisVerificationReporterService when denied",
  (it) => {
    it.effect("rejects records from callers without project access", () =>
      Effect.gen(function* () {
        const service = yield* AxisVerificationReporterService;
        const error = yield* Effect.flip(service.record(caller, baseInput));
        assert.equal(error._tag, "AxisVerificationScopeError");
      }),
    );
  },
);

import { DETERMINISTIC_ENGINE_ID, TokenEfficiencyEngineId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";

import {
  makeTokenEfficiencyEngine,
  type CompactionRequest,
  type TokenEfficiencyTransform,
} from "./TokenEfficiencyEngine.ts";
import { makeRecoveryStore } from "./recoveryStore.ts";

// Real output, not a toy: the compactor declines runs whose marker would cost
// more than the lines it replaces, so a fixture of four short words compacts
// to nothing and would test the wrong branch.
const NOISE = "  npm warn deprecated transitive dependency, see the log for details";
const REPEATED = ["start", NOISE, NOISE, NOISE, NOISE, "done"].join("\n");

const request = (overrides?: Partial<CompactionRequest>): CompactionRequest => ({
  text: REPEATED,
  kind: "terminal-output",
  contextKey: "ctx-1",
  mode: "compress",
  ...overrides,
});

const withTransform = (transform: TokenEfficiencyTransform) =>
  makeTokenEfficiencyEngine({
    transforms: new Map([[DETERMINISTIC_ENGINE_ID, transform]]),
  });

describe("modes", () => {
  it.effect("does no work at all when off", () =>
    makeTokenEfficiencyEngine()
      .compact(request({ mode: "off" }))
      .pipe(
        Effect.map((outcome) => {
          expect(outcome).toMatchObject({
            text: REPEATED,
            applied: false,
            skippedReason: "mode-off",
          });
          expect(outcome.estimatedTokensBefore).toBe(0);
          expect(outcome.estimatedTokensAfter).toBe(0);
        }),
      ),
  );

  // `record` has to be indistinguishable from `off` on the wire while still
  // producing a real number, or an A/B measures its own side effects.
  it.effect("measures without mutating in record mode", () =>
    makeTokenEfficiencyEngine()
      .compact(request({ mode: "record" }))
      .pipe(
        Effect.map((outcome) => {
          expect(outcome.text).toBe(REPEATED);
          expect(outcome.applied).toBe(false);
          expect(outcome.skippedReason).toBe("record-mode");
          expect(outcome.estimatedTokensAfter).toBeLessThan(outcome.estimatedTokensBefore);
          expect(outcome.recoveryHandle).toBeUndefined();
        }),
      ),
  );

  it.effect("transforms and reports a saving in compress mode", () =>
    makeTokenEfficiencyEngine()
      .compact(request())
      .pipe(
        Effect.map((outcome) => {
          expect(outcome.applied).toBe(true);
          expect(outcome.text).not.toBe(REPEATED);
          expect(outcome.text).toContain("repeated 3 more times");
          expect(outcome.estimatedTokensAfter).toBeLessThan(outcome.estimatedTokensBefore);
        }),
      ),
  );
});

describe("protected payloads", () => {
  it.effect("passes through kinds the caller could not classify", () =>
    makeTokenEfficiencyEngine()
      .compact(request({ kind: "unknown" }))
      .pipe(
        Effect.map((outcome) => {
          expect(outcome).toMatchObject({
            text: REPEATED,
            applied: false,
            skippedReason: "protected-kind:unknown",
          });
        }),
      ),
  );

  it.effect("passes through a kind outside the contract entirely", () =>
    makeTokenEfficiencyEngine()
      .compact(request({ kind: "user-request" as CompactionRequest["kind"] }))
      .pipe(
        Effect.map((outcome) => {
          expect(outcome.applied).toBe(false);
          expect(outcome.skippedReason).toBe("unknown-payload-kind");
        }),
      ),
  );
});

describe("invariants", () => {
  // 1. Fail open. A compressor must never be able to break a Turn.
  it.effect("passes the original through when the engine throws", () =>
    withTransform(() => {
      throw new Error("engine exploded");
    })
      .compact(request())
      .pipe(
        Effect.map((outcome) => {
          expect(outcome.text).toBe(REPEATED);
          expect(outcome.applied).toBe(false);
          expect(outcome.skippedReason).toBe(`engine-failed:${DETERMINISTIC_ENGINE_ID}`);
        }),
      ),
  );

  it.effect("passes the original through when the engine returns malformed data", () =>
    withTransform(() => null)
      .compact(request())
      .pipe(
        Effect.map((outcome) => {
          expect(outcome.text).toBe(REPEATED);
          expect(outcome.applied).toBe(false);
          expect(outcome.skippedReason).toBe(`engine-failed:${DETERMINISTIC_ENGINE_ID}`);
        }),
      ),
  );

  it.effect("passes through when settings name an engine this build lacks", () =>
    makeTokenEfficiencyEngine()
      .compact(request({ engine: TokenEfficiencyEngineId.make("someForkEngine") }))
      .pipe(
        Effect.map((outcome) => {
          expect(outcome.text).toBe(REPEATED);
          expect(outcome.skippedReason).toBe("unknown-engine:someForkEngine");
        }),
      ),
  );

  // 2. Never net-negative — the real failure mode of template rewriters.
  it.effect("discards a transform that grew the payload", () =>
    withTransform((text) => `${text}\n${text}`)
      .compact(request())
      .pipe(
        Effect.map((outcome) => {
          expect(outcome.text).toBe(REPEATED);
          expect(outcome.applied).toBe(false);
          expect(outcome.skippedReason).toBe("no-saving");
          expect(outcome.estimatedTokensAfter).toBeGreaterThan(outcome.estimatedTokensBefore);
        }),
      ),
  );

  // 3. Recoverable. No transform without a way back to the original.
  it.effect("declines to transform when the original cannot be retained", () =>
    makeTokenEfficiencyEngine({
      transforms: new Map([[DETERMINISTIC_ENGINE_ID, () => "tiny"]]),
      recoveryStore: {
        retain: () => Effect.succeed(undefined),
        recover: () => Effect.succeed(undefined),
      },
    })
      .compact(request())
      .pipe(
        Effect.map((outcome) => {
          expect(outcome.text).toBe(REPEATED);
          expect(outcome.applied).toBe(false);
          expect(outcome.skippedReason).toBe("not-recoverable");
        }),
      ),
  );

  it.effect("hands back the original through the handle it issued", () =>
    Effect.gen(function* () {
      const engine = makeTokenEfficiencyEngine({ recoveryStore: makeRecoveryStore() });
      const outcome = yield* engine.compact(request());
      expect(outcome.applied).toBe(true);
      expect(yield* engine.recover({ contextKey: "ctx-1", handle: outcome.recoveryHandle! })).toBe(
        REPEATED,
      );
      // A handle is scoped to the context that created it.
      expect(
        yield* engine.recover({ contextKey: "ctx-2", handle: outcome.recoveryHandle! }),
      ).toBeUndefined();
    }),
  );

  it.effect("never transforms a payload carrying a credential", () =>
    Effect.gen(function* () {
      // Retaining it would put a secret in the store; refusing to retain
      // therefore also refuses to transform, which is the right outcome.
      const secretive = ["api_key = abcdefghij", NOISE, NOISE, NOISE, NOISE].join("\n");
      const outcome = yield* makeTokenEfficiencyEngine().compact(request({ text: secretive }));
      expect(outcome.text).toBe(secretive);
      expect(outcome.applied).toBe(false);
      expect(outcome.skippedReason).toBe("not-recoverable");
    }),
  );
});

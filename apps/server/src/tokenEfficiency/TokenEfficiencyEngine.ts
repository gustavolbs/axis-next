/**
 * The replaceable boundary every compressor plugs into.
 *
 * Callers hand over a payload and get one back. They never learn which engine
 * ran, whether it ran, or why it declined — beyond the statistics they report
 * — so an engine can be swapped, benchmarked, or disabled without a single
 * call site changing. That is the whole point: the roadmap's benchmark
 * (no compression vs deterministic vs LLMLingua-2 vs Caveman) has to be a
 * settings change, not a refactor.
 *
 * Three invariants hold for every engine, enforced here rather than trusted
 * to each implementation:
 *
 *   1. **Fail open.** Any failure — classification, transform, estimation,
 *      storage — passes the original through. A compressor must never be able
 *      to break a Turn.
 *   2. **Never net-negative.** A transform that does not actually reduce the
 *      estimate is discarded, so a bad engine costs latency, not tokens.
 *   3. **Recoverable.** A payload that changed is retained first. If it
 *      cannot be retained, it is not transformed.
 *
 * @module tokenEfficiency/TokenEfficiencyEngine
 */
import {
  DETERMINISTIC_ENGINE_ID,
  isTokenEfficiencyPayloadKind,
  type TokenEfficiencyEngineId,
  type TokenEfficiencyMode,
  type TokenEfficiencyOutcome,
  type TokenEfficiencyPayloadKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { isCompressiblePayloadKind } from "./contentSafety.ts";
import { compactDeterministically, estimateTokens } from "./deterministicCompaction.ts";
import { makeRecoveryStore, type RecoveryStore } from "./recoveryStore.ts";

export interface CompactionRequest {
  readonly text: string;
  readonly kind: TokenEfficiencyPayloadKind;
  /**
   * Scopes the recovery handle. An Axis context / thread key: originals from
   * one context are never readable from another.
   */
  readonly contextKey: string;
  readonly mode: TokenEfficiencyMode;
  readonly engine?: TokenEfficiencyEngineId | undefined;
}

/** A pure transform. Runtime validation keeps third-party engines fail-open. */
export type TokenEfficiencyTransform = (text: string) => unknown;

export interface TokenEfficiencyEngineRegistry {
  readonly compact: (request: CompactionRequest) => Effect.Effect<TokenEfficiencyOutcome>;
  readonly recover: (input: {
    readonly contextKey: string;
    readonly handle: string;
  }) => Effect.Effect<string | undefined>;
}

const passThrough = (text: string, reason: string, tokens = 0): TokenEfficiencyOutcome => ({
  text,
  applied: false,
  engine: undefined,
  estimatedTokensBefore: tokens,
  estimatedTokensAfter: tokens,
  recoveryHandle: undefined,
  skippedReason: reason,
});

const BUILT_IN_TRANSFORMS: ReadonlyMap<string, TokenEfficiencyTransform> = new Map([
  [DETERMINISTIC_ENGINE_ID, (text: string) => compactDeterministically(text).text],
]);

export const makeTokenEfficiencyEngine = (input?: {
  readonly transforms?: ReadonlyMap<string, TokenEfficiencyTransform>;
  readonly recoveryStore?: RecoveryStore;
}): TokenEfficiencyEngineRegistry => {
  const transforms = input?.transforms ?? BUILT_IN_TRANSFORMS;
  const store = input?.recoveryStore ?? makeRecoveryStore();

  const compact = (request: CompactionRequest): Effect.Effect<TokenEfficiencyOutcome> =>
    Effect.gen(function* () {
      if (request.mode === "off") return passThrough(request.text, "mode-off");
      if (!isTokenEfficiencyPayloadKind(request.kind)) {
        return passThrough(request.text, "unknown-payload-kind");
      }
      if (!isCompressiblePayloadKind(request.kind)) {
        return passThrough(request.text, `protected-kind:${request.kind}`);
      }

      const engineId = request.engine ?? DETERMINISTIC_ENGINE_ID;
      const transform = transforms.get(engineId);
      if (transform === undefined) {
        // A settings file naming an engine this build does not ship must not
        // break the Turn; it degrades to no compression.
        return passThrough(request.text, `unknown-engine:${engineId}`);
      }

      const before = estimateTokens(request.text);
      let recoveryHandle: string | undefined;
      if (request.mode === "compress") {
        // Retain before invoking an untrusted engine. If it throws or returns
        // malformed data, the original is still available for diagnostics.
        recoveryHandle = yield* store
          .retain({ contextKey: request.contextKey, original: request.text })
          .pipe(Effect.catchCause(() => Effect.succeed(undefined)));
        if (recoveryHandle === undefined) {
          return passThrough(request.text, "not-recoverable", before);
        }
      }

      // Invariant 1: a throwing engine is a declining engine.
      const transformed = yield* Effect.try(() => transform(request.text)).pipe(
        Effect.catchCause(() => Effect.succeed(undefined)),
      );
      if (typeof transformed !== "string") {
        if (recoveryHandle !== undefined && store.release !== undefined) {
          yield* store.release(recoveryHandle).pipe(Effect.catchCause(() => Effect.void));
        }
        return passThrough(request.text, `engine-failed:${engineId}`, before);
      }

      const after = estimateTokens(transformed);
      // Invariant 2. Also catches an engine that "compressed" into something
      // longer, which is a real failure mode for template-based rewriters.
      if (transformed === request.text || after >= before) {
        if (recoveryHandle !== undefined && store.release !== undefined) {
          yield* store.release(recoveryHandle).pipe(Effect.catchCause(() => Effect.void));
        }
        return {
          ...passThrough(request.text, "no-saving", before),
          engine: engineId,
          estimatedTokensAfter: after,
        };
      }

      // `record` measures the saving and sends the original anyway. This is
      // the mode an A/B runs in, so it must be indistinguishable from `off`
      // on the wire while still reporting a real number.
      if (request.mode === "record") {
        return {
          text: request.text,
          applied: false,
          engine: engineId,
          estimatedTokensBefore: before,
          estimatedTokensAfter: after,
          recoveryHandle: undefined,
          skippedReason: "record-mode",
        };
      }

      return {
        text: transformed,
        applied: true,
        engine: engineId,
        estimatedTokensBefore: before,
        estimatedTokensAfter: after,
        recoveryHandle,
        skippedReason: undefined,
      };
    });

  return { compact, recover: store.recover };
};

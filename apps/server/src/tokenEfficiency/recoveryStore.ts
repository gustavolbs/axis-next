/**
 * Keeps the original payload alive after a lossy transform.
 *
 * A compressor that cannot produce the original on request is a compressor
 * nobody can debug: when a Turn goes wrong, the first question is always
 * whether the model saw the real output. Handles are context-scoped and
 * expire, because this store exists for the length of an investigation, not
 * as a second copy of the workspace.
 *
 * @module tokenEfficiency/recoveryStore
 */
import * as Effect from "effect/Effect";
import { containsSecret } from "./contentSafety.ts";

export interface RecoveryStoreOptions {
  readonly ttlMs: number;
  /** Hard cap on retained entries; the oldest are dropped first. */
  readonly maxEntries: number;
}

export const DEFAULT_RECOVERY_STORE_OPTIONS: RecoveryStoreOptions = {
  ttlMs: 30 * 60_000,
  maxEntries: 256,
};

interface Entry {
  readonly contextKey: string;
  readonly original: string;
  readonly expiresAt: number;
}

export interface RecoveryStore {
  /**
   * Retain `original` and return its handle, or `undefined` when it must not
   * be retained. Refusing is not an error: the caller then declines to
   * transform, so nothing is ever lost that cannot be recovered.
   */
  readonly retain: (input: {
    readonly contextKey: string;
    readonly original: string;
  }) => Effect.Effect<string | undefined>;
  /**
   * Read an original back. Requires the same `contextKey` that stored it, so
   * one Axis context cannot read another's payloads by guessing a handle.
   */
  readonly recover: (input: {
    readonly contextKey: string;
    readonly handle: string;
  }) => Effect.Effect<string | undefined>;
  /** Remove an unused handle after a transform declines to change the text. */
  readonly release?: (handle: string) => Effect.Effect<void>;
}

/**
 * In-memory store. Deliberately not persisted: originals are the least
 * reviewed, highest-volume data the server touches, and writing them to disk
 * would outlive the investigation they exist for.
 */
export const makeRecoveryStore = (
  options: RecoveryStoreOptions = DEFAULT_RECOVERY_STORE_OPTIONS,
  now: () => number = Date.now,
): RecoveryStore => {
  const entries = new Map<string, Entry>();
  let nextId = 0;

  const evictExpired = (at: number) => {
    for (const [handle, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(handle);
    }
  };

  return {
    retain: ({ contextKey, original }) =>
      Effect.sync(() => {
        // A store of originals is a store of secrets unless something refuses
        // first. Refusing here makes the caller pass the payload through
        // untouched, which is the correct outcome for credential-bearing
        // output anyway.
        if (containsSecret(original)) return undefined;
        const at = now();
        evictExpired(at);
        while (entries.size >= options.maxEntries) {
          const oldest = entries.keys().next();
          if (oldest.done === true) break;
          entries.delete(oldest.value);
        }
        const handle = `tef-${at.toString(36)}-${(nextId += 1).toString(36)}`;
        entries.set(handle, { contextKey, original, expiresAt: at + options.ttlMs });
        return handle;
      }),

    recover: ({ contextKey, handle }) =>
      Effect.sync(() => {
        const at = now();
        evictExpired(at);
        const entry = entries.get(handle);
        return entry !== undefined && entry.contextKey === contextKey ? entry.original : undefined;
      }),

    release: (handle) =>
      Effect.sync(() => {
        entries.delete(handle);
      }),
  };
};

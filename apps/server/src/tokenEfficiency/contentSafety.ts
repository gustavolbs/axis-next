/**
 * What a compressor is forbidden to touch.
 *
 * The asymmetry that shapes this module: dropping a repeated log line costs
 * nothing, while dropping a character from a diff, a command, a path, or a
 * secret produces output that still *looks* right and is wrong in a way the
 * model cannot detect. So the rule is not "compress unless risky" but
 * "protect unless proven safe", and every ambiguous case resolves to
 * protected.
 *
 * This module only decides *whether* something may be transformed. How it is
 * transformed lives in the compactor.
 *
 * @module tokenEfficiency/contentSafety
 */
import type { TokenEfficiencyPayloadKind } from "@t3tools/contracts";

/**
 * Payload kinds a compressor may consider. Everything else — including
 * `unknown` — is protected wholesale, because the caller is the only party
 * that knows what it is holding.
 */
const COMPRESSIBLE_KINDS: ReadonlySet<TokenEfficiencyPayloadKind> = new Set([
  "terminal-output",
  "search-results",
  "accessibility-tree",
  "tool-result",
  "log",
]);

export function isCompressiblePayloadKind(kind: TokenEfficiencyPayloadKind): boolean {
  return COMPRESSIBLE_KINDS.has(kind);
}

/**
 * Line-level guards. A payload of a compressible kind can still *contain*
 * regions that must survive byte-for-byte, so the compactor asks per line.
 *
 * These are deliberately over-broad. A false positive costs a few tokens of
 * missed savings; a false negative corrupts a command someone runs.
 */
const PROTECTED_LINE_PATTERNS: ReadonlyArray<{ readonly why: string; readonly test: RegExp }> = [
  // Diff and patch structure: a dropped hunk header silently rewrites what
  // the patch means.
  { why: "diff", test: /^(?:diff --git |index [0-9a-f]{7,}|@@ |\+\+\+ |--- |[+-])/u },
  // Anything that looks like a shell invocation the reader might run.
  { why: "command", test: /^\s*(?:\$|#|>|PS[ >])\s*\S/u },
  // Paths and URLs: truncating either produces a plausible, wrong location.
  { why: "path-or-url", test: /(?:[a-z][a-z0-9+.-]*:\/\/|(?:^|\s)(?:\.{0,2}\/)[^\s]*\/)/iu },
  // Structure carriers. Collapsing a repeated `}` changes the shape.
  { why: "structured-data", test: /^[\s]*[[\]{}]|["']\s*:\s*/u },
  // Errors, stack frames, and failures are the reason the payload is being
  // read at all.
  { why: "error", test: /\b(?:error|exception|traceback|panic|fatal|failed|stack trace)\b/iu },
  { why: "stack-frame", test: /^\s*at\s+\S+|^\s{2,}File "/u },
  // Identifiers a reader may copy: hashes, UUIDs, long digit runs.
  { why: "identifier", test: /\b(?:[0-9a-f]{7,}|[0-9A-Za-z_-]{16,}|\d{4,})\b/u },
  // Credentials, in every shape we can cheaply recognize. These must never
  // reach a recovery store, let alone a lossy transform.
  {
    why: "secret",
    test: /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|xox[baprs]-|AKIA[0-9A-Z]{8,}|eyJ[A-Za-z0-9_-]{8,}\.)|(?:api[_-]?key|secret|token|password|passwd|credential|authorization|bearer)\s*[:=]/iu,
  },
];

export interface LineProtection {
  readonly protected: boolean;
  /** Which rule matched, for statistics and for explaining a low saving. */
  readonly why: string | undefined;
}

const UNPROTECTED: LineProtection = { protected: false, why: undefined };

/**
 * Decide whether one line must survive byte-for-byte.
 *
 * Blank lines are unprotected: collapsing runs of them is the safest saving
 * there is.
 */
export function classifyLine(line: string): LineProtection {
  if (line.trim().length === 0) return UNPROTECTED;
  for (const rule of PROTECTED_LINE_PATTERNS) {
    if (rule.test.test(line)) return { protected: true, why: rule.why };
  }
  return UNPROTECTED;
}

/**
 * True when a payload contains anything credential-shaped.
 *
 * Used as a hard stop before the payload is written anywhere, including the
 * recovery store: a store that keeps originals is a store that keeps secrets
 * unless something refuses first.
 */
export function containsSecret(text: string): boolean {
  const rule = PROTECTED_LINE_PATTERNS.find((entry) => entry.why === "secret");
  return rule !== undefined && text.split("\n").some((line) => rule.test.test(line));
}

# Token efficiency

Reducing what a Turn costs without changing what it means. Separate from the
learning layer: nothing here proposes process improvements, and nothing here
may alter intent.

## Why there is a boundary at all

The roadmap requires benchmarking several compressors — a deterministic
compactor, Caveman Engine, LLMLingua-2 — against no compression at all. If
each engine wired itself into orchestration, that comparison would be a
refactor per candidate and the results would not be comparable. So engines are
pure transforms behind one registry, and switching or disabling one is a
settings change. External engines may return a promise, but the registry still
owns the same safety invariants.

The registry, not the engine, enforces the three properties that make a
compressor safe to run in production. Engines are third-party or experimental
by assumption, so none of these may be delegated to them:

1. **Fail open.** A throwing engine, an unknown engine id, an unreadable
   payload — all pass the original through. A compressor must never be able to
   break a Turn.
2. **Never net-negative.** A transform whose output does not reduce the token
   estimate is discarded. This catches the characteristic failure of
   template-based rewriters, which can expand short inputs.
3. **Recoverable.** A payload that changed is retained first; if it cannot be
   retained, it is not transformed. A compressor whose output cannot be traced
   back to its input is one nobody can debug when a Turn goes wrong.

## Why the estimate is not the bill

`estimateTokens` is characters ÷ 4. It decides only whether a transform was
worth applying. Billed counts come from the usage layer after the Turn, from
what the provider reported. Feeding estimates into savings statistics would
let an engine take credit for tokens it did not save, which is exactly what
the A/B exists to measure — so the two numbers are kept apart deliberately,
not merely because the estimate is rough.

## Why the payload kind comes from the caller

The compressor never infers what it is holding. A caller knows whether a
string is terminal output or a diff; content-sniffing gets that wrong on
exactly the inputs where being wrong is unrecoverable. An unclassified payload
is protected, so adding a new call site fails safe by default.

Within a compressible payload, protection is decided per line, and the rules
are deliberately over-broad: a false positive costs a few tokens of missed
saving, a false negative corrupts a command someone runs. The protected set —
diffs, commands, paths, URLs, structured data, errors, stack frames,
identifiers, credentials — comes from the roadmap and is enforced in
`contentSafety.ts`.

Repetition is itself signal. Four identical stack frames mean a loop, so
protected lines are never collapsed even when they repeat.

## Why a marker can cost more than it saves

Collapsing a run emits `… previous line repeated N more times`, roughly 45
characters. Four repetitions of a seven-character line cost less than the
announcement. The compactor therefore checks that a run actually shrinks
before collapsing it — not as an optimization, but because the registry
discards a net-negative payload wholesale, which would throw away every real
saving in it alongside the bad one.

## Why originals are never persisted

The recovery store is in memory and expiring. Originals are the highest-volume,
least-reviewed data the server handles; writing them to disk would outlive the
investigation they exist for. The store also refuses credential-bearing
payloads outright — a store of originals is a store of secrets unless
something refuses first — which, through invariant 3, means such payloads are
never compressed either.

## Current state

`off` everywhere. No compressor ships enabled, per the adoption rule: none may
until an A/B proves lower provider-billed tokens at equivalent task quality
and acceptable latency. `record` is the mode that A/B runs in — it measures
the saving and sends the original, so it is indistinguishable from `off` on
the wire. An opt-in provider-owned concise-output profile is available across
the six provider adapters, with per-instance settings taking precedence over
the server default. Claude's SDK binds the system prompt when its session is
created, so changing the profile while a Claude session is active takes effect
on the next session; the other adapters read the profile at turn dispatch.

Provider turn completion events feed aggregate, in-memory baselines and
rollout metrics per provider instance/model/context. Each metric carries
availability metadata, so an observed zero is distinct from a provider field
that was not exposed. The first call sites are `preview_evaluate` and
`preview_snapshot`: textual fields and structured accessibility-tree leaves may
be compacted when the instance is explicitly opted in, and each original is
recoverable with a context-scoped, expiring handle. ACP runtimes also expose an
optional fail-open `terminal/output` transform hook for provider adapters.

An externally installed Caveman executable can be configured with
`T3_CAVEMAN_ENGINE_COMMAND`; it is record-only, never bundled, and its stderr
is not forwarded. `TokenEfficiencyBenchmark` provides bilingual fixtures for
Codex, Claude, Work Hub, remote-dispatch, and scheduled-agent comparisons, but
does not claim task-quality equivalence without a caller-supplied evaluator.
Runtime instructions keep a stable provider prompt prefix and append changing
model/effort/profile metadata afterward. The Hermes bridge accepts only
context-scoped aggregate observations and emits evidence; it cannot activate a
compression policy. Native provider search adapters, real Caveman/LLMLingua
benchmark runs, reviewed task-quality scores, and Hermes proposal evaluation
remain future roadmap work.

Source: `apps/server/src/tokenEfficiency/`, contracts in
`packages/contracts/src/tokenEfficiency.ts`.

# Learning layer

## Purpose

The Axis learning layer improves recurring workflows from observed outcomes without becoming an
agent runtime or silently rewriting product behavior. Hermes, or a compatible engine, may analyze
context-scoped execution evidence and produce reviewable proposals. T3 remains responsible for
provider execution, Threads, Turns, approvals, activities, checkpoints, and scheduling.

The first integration treats Hermes as an optional learning engine behind an Axis-owned contract,
not as a new provider type. Replacing the engine must not change the ownership, isolation, review,
or rollback model described here.

## Evidence and output

The learning layer may consume existing, authorized records such as:

- completed T3 Turns, tool outcomes, approvals, failures, and checkpoints;
- explicit user corrections, ratings, and accepted or rejected proposals;
- context-owned Shared Memory and Work Hub projections; and
- scheduled-activity outcomes and connector health metadata.

It stores only the derived evidence references, evaluation results, and proposals that Axis needs.
Every record retains its `contextId`, provider instance when applicable, source identity, and the
event sequence or cursor used to derive it. Reprocessing the same evidence is idempotent.

Initial proposal kinds are:

- create or revise a provider-owned skill;
- revise provider-owned instructions or preferences;
- adjust a Work Hub collection policy;
- create or revise a scheduled activity; and
- recommend a provider, MCP, or workflow for a recurring task.

A proposal is not active configuration. It includes the motivation and evidence, a structured diff,
the affected context and provider, evaluation results, and its expected effect.

## Review, versioning, and rollback

The lifecycle is explicit:

```text
observed evidence
  -> isolated candidate
  -> evaluation and policy checks
  -> user review
  -> approved version
  -> monitored outcome
  -> retain or roll back
```

Rejecting or dismissing a proposal is a durable outcome and helps prevent the same unsuitable
change from being proposed repeatedly. Approval creates a new immutable version; it does not mutate
the previous version in place. Activation and rollback are separate, auditable operations, and the
last known-good version remains recoverable.

Before review, candidates should be checked for duplication, conflicts, regressions against stored
examples, accidental secret inclusion, prompt injection, and permission expansion. An automated
evaluation may reject a candidate, but it cannot approve one on the user's behalf in the initial
implementation.

## Isolation and authority

Learning follows the same boundaries as execution:

- Personal, Company A, and Company B have separate evidence, proposals, evaluations, and derived
  memory. A shared user interface does not create a shared learning corpus.
- A provider-owned skill, instruction, preference, or MCP configuration remains attached to that
  provider. The proposal also records the context whose work produced the evidence.
- Using a Personal provider in a Company does not allow Company evidence to enter Personal memory
  or another Company. A proposal derived there may improve a Company-owned process, but it cannot
  activate a change to the Personal provider's capabilities until the user explicitly promotes it
  and Company policy permits that disclosure.
- Company policy may disable learning, restrict retained evidence, require additional approval, or
  prohibit promotion outside the Company.
- The learning engine receives only the minimum records authorized for the proposal. It never reads
  credential stores, raw provider homes, or unrelated provider sessions.

The learning layer cannot grant provider access, enable an MCP, broaden connector permissions,
approve source-system mutations, or change retention policy. Those remain explicit Axis/T3
operations with their existing authorization and approval rules.

## Scheduled learning

Learning may be invoked after a completed task or by an Axis scheduled activity, such as a weekly
workflow review. The scheduler records the target context, learning policy, next run, last outcome,
and delivery destination. A scheduled learning run produces proposals or a no-change result; it
does not activate improvements automatically.

Work Hub source refresh and learning are distinct jobs. Refresh deterministically updates one
context-owned connector snapshot. Learning may later inspect that snapshot and its outcomes, but it
must not replace connector adapters or make refresh depend on an open-ended agent loop.

## Delivery stages

The capability is introduced in dependency order:

1. Context identity and provider policy are enforced at Thread launch, projection, cache, and
   retrieval boundaries.
2. The narrow Axis scheduler adds context, provider/MCP selection, history, pause/resume, run-now,
   and per-source failure isolation; agent work enters the normal T3 orchestration lifecycle.
3. Execution evidence and explicit user corrections are recorded with provenance and retention.
4. A provider-independent proposal store and review surface add immutable versions, activation,
   rejection, and rollback.
5. Hermes is connected as the first optional learning engine for offline proposal generation.
6. Evaluation gates and outcome monitoring support skill, instruction, collection-policy, and
   scheduled-activity proposals.

Each stage is complete only when its contract, server behavior, supported client surfaces, reverse
operations, remote behavior, and focused tests agree. Later stages must not weaken an earlier
stage's isolation or approval guarantees.

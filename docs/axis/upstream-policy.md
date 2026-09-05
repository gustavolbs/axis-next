# Axis upstream and change policy

T3 Code is the infrastructure upstream for Axis Next. The fork should remain close enough to T3 that infrastructure improvements can be absorbed without repeatedly resolving avoidable Axis-specific conflicts.

## Default change policy

For Axis feature work:

1. inspect how T3 currently models and executes the capability;
2. identify existing contracts, projections, adapters, registries, and services that can be reused;
3. state what is reused unchanged;
4. state the concrete product/domain gap;
5. prefer Axis-owned code and relationships over edits to T3 core;
6. list every existing T3 file that must be modified;
7. assess future upstream conflict risk before implementation;
8. add a new abstraction only when the gap cannot be expressed cleanly with existing T3 concepts.

Do not perform mass T3-to-Axis renames. In particular, do not rename internal server/runtime/home/package concepts solely for branding. Product branding can differ from internal infrastructure naming.

## Conflict-risk tiers

### Low risk

Prefer these changes whenever they are sufficient:

- new files under an Axis-owned namespace;
- Axis-owned tables/read models referencing T3 IDs;
- Axis UI composition over existing client/runtime data;
- provider-native configuration materialization implemented outside provider execution internals;
- documentation under `docs/axis/`.

### Medium risk

Use deliberately and keep changes narrow:

- wiring new Axis contracts into existing package exports;
- adding RPC methods to shared contract/server registration points;
- composing Axis services into server startup layers;
- registering Axis persistence migrations;
- adding shared Axis client state to `packages/client-runtime` integration points.

These are legitimate extension seams, but they are likely to move upstream.

### High risk

Require explicit justification in the PR:

- changing provider adapter semantics to support Axis organization;
- adding Axis account/runtime abstractions beside provider instances;
- changing T3 orchestration command/event semantics when composition would work;
- changing the core decider/projector for Axis-only metadata;
- adding Axis fields directly to core project/thread/session projections without a demonstrated invariant;
- modifying provider secret handling or adding a parallel secret store;
- reimplementing filesystem, terminal, Git, worktrees, remote transport, connection runtime, approvals, or provider execution;
- broad renames, formatting passes, or directory moves across upstream-owned code.

Persisted orchestration event schemas deserve extra caution: compatibility affects replay of existing environments, not only current clients.

## Feature preflight

Before implementing a relevant Axis feature, the PR or working analysis must answer:

- What T3 concept is closest to this requirement?
- Which stable T3 IDs or projections can the feature reference?
- Can the feature be a projection, relationship, or materializer instead of a new runtime?
- Does T3 already own the lifecycle being proposed?
- What data is genuinely Axis-owned?
- What must cross RPC, and can existing subscriptions/state carry part of it?
- Does the feature work across web, desktop, mobile, local, and remote environments where applicable?
- Which provider-specific behaviors differ?
- Which existing T3 files must change, and why can the change not remain in an Axis-owned path?
- What is the expected merge-conflict surface when T3 upstream changes?

If the answers expose uncertainty in the domain model, defer naming and schema creation until the uncertainty is resolved in code analysis.

## Provider-specific guardrails

Multiple accounts/configurations of the same provider remain T3 provider instances. Axis grouping sits above those instances.

Shared skills, MCPs, instructions, and preferences should be synchronized or materialized into provider-native mechanisms after the provider-specific resolution paths are understood. Do not force every provider into one synthetic runtime configuration model if its native semantics differ.

Sensitive provider values must use the existing T3 secret/redaction path when represented as provider-instance environment/configuration. A feature PR must prove a different security domain before introducing any other secret store.

## Work Hub and orchestration guardrails

Work Hub should prefer T3 projections for runs, activity, approvals, and execution state. Axis should add projections only for genuinely new product state or cross-domain composition.

Axis orchestration means higher-level workflow semantics over T3 execution: delegation, handoff, multi-step task coordination, and related product behavior. It does not mean a second provider execution engine.

## Upstream-touch note

Any Axis PR that edits an existing upstream-owned source file should include a short section in its PR description containing:

- the files touched;
- the missing extension point that required each touch;
- the conflict-risk tier;
- whether the change could reasonably be proposed upstream to T3.

If no upstream-owned file is changed, say so. This makes divergence intentional and reviewable without maintaining a separate source-code fork ledger.
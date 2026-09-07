# Axis architecture

Axis is a product built on T3 Code. T3 remains the agent harness and owns the infrastructure that
makes agent work reliable across machines and clients. Axis adds product-specific organization and
capabilities on top of those primitives.

The governing rule is:

> Extend T3; do not duplicate it.

In particular, Axis does not introduce parallel providers, projects, threads, terminals,
filesystems, Git models, worktrees, orchestration, or connection transports. Internal T3 names may
remain unchanged. Axis is the external product identity; a mass internal rename would add merge
conflicts without adding product value.

## Documents

- [Implementation roadmap](../../ROADMAP.md) is the tested checklist of completed work and upcoming
  milestones.
- [Architecture](./ARCHITECTURE.md) defines the ownership boundary, future composition model, and
  rules for Axis-specific code.
- [Contexts and provider access](./CONTEXTS.md) defines Personal/Company isolation and the safe,
  directional reuse of personal providers and capabilities inside a Company.
- [Work Hub](./WORK_HUB.md) defines the cross-context Overview, Calendar, Messages, and Work Board
  projections sourced through provider-connected MCPs.
- [Learning layer](./LEARNING.md) defines how Hermes or a compatible engine can propose safe,
  context-scoped improvements with review, versioning, and rollback.
- [Upstream](./UPSTREAM.md) defines how the fork stays close to `pingdotgg/t3code` and how upstream
  changes are synchronized.
- [Legacy migration](./LEGACY_MIGRATION.md) defines the decision framework for moving useful Axis
  Legacy behavior without moving its infrastructure debt.

These documents describe durable boundaries and may cover both implemented and planned slices. The
current implementation includes the Axis context/provider catalog, provider-owned MCP and skill
controls, API-key provider instances, and a web Work Hub with persisted source selection,
source-specific collection policy, per-source cache, manual Codex/Claude MCP sync, calendar
presentation, scheduled source refresh, and context-scoped scheduled agent Threads. Runtime context
enforcement for all ordinary Thread entry points, native provider connector configuration,
automatic provider failover, Shared Memory, source-system mutations, and native mobile presentation
remain staged work. The first Learning review slice now persists evidence/proposals/versions and
exposes explicit review, activation, rollback, and audit controls in Axis settings.

## Implementation sequence

The durable dependency order is:

1. enforce context ownership and effective provider bindings at runtime;
2. complete provider-owned MCP, skill, instruction, and preference management;
3. make Work Hub connector acquisition and normalization reliable across supported providers;
4. evolve context-scoped scheduled refresh into reusable T3 scheduling, then add agent activities;
5. derive Shared Memory and learning evidence with provenance and retention;
6. add proposal review, immutable versions, activation, rejection, and rollback; and
7. connect Hermes as an optional learning engine, then expand evaluated improvement types.

This sequence is dependency guidance rather than a release-date promise. A slice is complete only
after its server behavior, applicable clients and providers, reverse states, remote modes, and
focused tests agree.

## Decision shorthand

Before adding an Axis abstraction, ask:

1. Does T3 already own this concept or lifecycle?
2. Can the requirement be expressed as metadata, a projection, policy, or UI over the existing
   concept?
3. Can the implementation stay in an Axis namespace and cross T3 boundaries through existing
   contracts and services?
4. If T3 core must change, is the smallest generic improvement useful to upstream independently of
   Axis?

If the answer to the first question is yes, Axis extends that concept instead of replacing it.

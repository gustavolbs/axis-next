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

- [Architecture](./ARCHITECTURE.md) defines the ownership boundary, future composition model, and
  rules for Axis-specific code.
- [Contexts and provider access](./CONTEXTS.md) defines Personal/Company isolation and the safe,
  directional reuse of personal providers and capabilities inside a Company.
- [Work Hub](./WORK_HUB.md) defines the cross-context Overview, Calendar, Messages, and Work Board
  projections sourced through provider-connected MCPs.
- [Upstream](./UPSTREAM.md) defines how the fork stays close to `pingdotgg/t3code` and how upstream
  changes are synchronized.
- [Legacy migration](./LEGACY_MIGRATION.md) defines the decision framework for moving useful Axis
  Legacy behavior without moving its infrastructure debt.

These documents describe durable boundaries, not implemented Axis features. Companies, Workspaces,
Profiles, Shared Memory, Work Hub, Calendar, tasks, cross-agent orchestration, notifications, and
Axis-specific remote/mobile experiences are intentionally outside this foundation change.

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

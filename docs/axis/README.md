# Axis fork architecture

Axis Next is a product fork of T3 Code. T3 remains the infrastructure foundation; Axis adds product organization and cross-agent capabilities without replacing the T3 agent harness.

The governing rule for the fork is:

> If T3 already models or executes a capability and Axis only needs to organize, group, enrich, synchronize, or project it, extend T3 instead of duplicating it.

## What T3 remains responsible for

Unless a concrete limitation is demonstrated in the current implementation, T3 owns:

- provider drivers and adapters;
- provider instances and provider-specific configuration;
- Claude Code, Codex, and other provider integrations;
- agent execution and provider session lifecycle;
- base orchestration, commands, events, reactors, and projections;
- threads, turns, approvals, and execution state;
- checkpoints, worktrees, filesystem access, file reading, terminal, Git, and diffs;
- the base Project model;
- RPC contracts, authenticated remote transport, environments, and connection runtime;
- web, desktop, and mobile foundations;
- secure storage and redaction of sensitive provider configuration.

Internal T3 names are allowed to remain T3 names. Axis does not rename infrastructure merely to make the fork look branded.

## What Axis is expected to add

Axis may add product concepts that are not already represented by T3, including:

- semantic organization across companies and work contexts;
- grouping of existing T3 provider instances into a shared context;
- shared agent configuration that is materialized into provider-native mechanisms;
- cross-provider shared memory;
- Work Hub projections, tasks, and calendar experiences;
- Axis-specific cross-agent workflows built on T3 orchestration;
- notifications;
- Axis-specific remote and mobile product UX;
- Axis metadata and relationships over existing T3 projects and threads.

These are product directions, not permission to create all of these entities or services immediately. Each feature must first prove the gap it fills.

## Provider rule

A provider driver represents an integration. A provider instance represents one account/configuration of that integration.

For example, `Claude Personal`, `Claude Enterprise`, and `Claude API Personal` should be different Claude provider instances when the existing Claude driver and provider-instance configuration can express them. Axis must not introduce parallel `AxisProvider`, `AxisProviderAccount`, `AxisAuthenticationMethod`, or `AxisProviderRuntime` concepts for the same purpose.

Likewise, API-key support should use existing provider-instance environment/configuration and sensitive-value infrastructure whenever the provider supports that configuration natively.

## Working terminology

Two product terms are intentionally not frozen as internal type names yet:

- **Workspace**: T3 already uses workspace terminology for environment-local filesystem/worktree roots. The Axis organizational concept needs a PR-specific domain analysis before choosing its internal name.
- **Profile**: the desired grouping above provider instances is valid as a product requirement, but the final domain name must follow analysis of existing T3 profile/configuration concepts and provider extension points.

UI vocabulary and internal model names do not have to be identical.

## Documents

- [Architecture and extension model](./architecture.md)
- [Upstream and change policy](./upstream-policy.md)

These documents define the boundary for future Axis work. Feature PRs should refine them only when code proves an existing assumption wrong.
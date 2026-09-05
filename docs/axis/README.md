# Axis fork architecture

Axis Next is a product fork of T3 Code. T3 remains the infrastructure foundation; Axis adds semantic organization, context boundaries, cross-context projections, and Axis-specific workflows without replacing the T3 agent harness.

The governing rule for the fork is:

> If T3 already models or executes a capability and Axis only needs to organize, authorize, group, enrich, synchronize, materialize, or project it, extend T3 instead of duplicating it.

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
- secure handling and redaction of sensitive provider configuration.

Internal T3 names are allowed to remain T3 names. Axis does not rename infrastructure merely to make the fork look branded.

## What Axis is expected to add

Axis may add product concepts that are not already represented by T3, including:

- isolated Personal and Company contexts, with Workspace organization where useful;
- Axis relationships that make existing T3 projects and provider instances available in the correct contexts;
- shared agent configuration that is selectively materialized into provider-native skills, MCPs, instructions, and configuration;
- cross-provider Shared Memory;
- Work Hub projections across authorized Personal and Company sources;
- Axis-specific cross-agent workflows built on T3 orchestration;
- notifications;
- Axis-specific remote and mobile product UX;
- Axis metadata and relationships over existing T3 projects and threads.

These are product directions, not permission to create all of these entities or services immediately. Each feature must first prove the gap it fills.

## Context rule

Personal and each Company are data/knowledge boundaries. Company A must not implicitly see Company B, and Personal must not implicitly see Company data.

Provider instances are reusable execution resources, not the context boundary itself. A Personal Claude or Codex provider instance may be authorized for work in a Company without exposing unrelated Personal projects, threads, memory, messages, files, MCP data, or another Company's data.

Work Hub is intentionally different: it is a private user-facing aggregation across authorized contexts. Its aggregate is not implicit agent context for any Company.

## Provider rule

A provider driver represents an integration. A provider instance represents one account/configuration of that integration.

For example, `Claude Personal`, `Claude Enterprise`, and `Claude API Personal` should be different Claude provider instances when the existing Claude driver and provider-instance configuration can express them. Axis must not introduce parallel `AxisProvider`, `AxisProviderAccount`, `AxisAuthenticationMethod`, or `AxisProviderRuntime` concepts for the same purpose.

Likewise, API-key support should use existing provider-instance environment/configuration and sensitive-value infrastructure whenever the provider supports that configuration natively.

Sharing a provider instance does not automatically share every skill, MCP, instruction, or memory item associated with its origin context. Later shared-configuration work must preserve that distinction.

## Work Hub direction

Work Hub is a projection over authorized Personal and Company sources, not a replacement for Jira, Slack, calendar systems, T3 orchestration, or provider runtimes. Its primary surfaces are:

- **Overview** — today's cross-context summary;
- **Calendar** — Personal and Company events in one calendar experience;
- **Messages** — important Jira/project-tool, Slack, and similar work communications;
- **Work Board** — a normalized `TO DO`, `WORKING`, `BLOCKED`, `CODE REVIEW`, `QA`, `DONE` view backed by each source work-management tool.

The intended external-data path is the MCP/provider configuration authorized for each context. PR #1 does not introduce a generic Axis MCP runtime or direct Jira/Slack integration framework.

## Working terminology

Two terms remain deliberately open until their feature PRs inspect the current implementation in more detail:

- **Workspace**: T3 already uses workspace terminology for environment-local filesystem/worktree roots. The Axis organizational concept must avoid colliding with or replacing that primitive.
- **Profile**: PR #1 does not establish a Profile entity. Personal/Company may already provide enough semantic grouping; a separate reusable Profile should exist only if later shared-configuration or identity requirements prove it useful.

Chat and Cowork similarly do not establish new session runtimes. T3 Thread/Turn/provider-session state remains the basis; any Cowork concept should be a workflow/view over those primitives unless later requirements prove otherwise.

## Documents

- [Architecture and extension model](./architecture.md)
- [Upstream and change policy](./upstream-policy.md)

These documents define the boundary for future Axis work. Feature PRs should refine them only when code proves an existing assumption wrong.
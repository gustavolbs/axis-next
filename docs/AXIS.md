# Axis

Axis is a product layer built on top of T3 Code's agent-harness infrastructure.

The goal is one application for organizing and controlling multiple AI agents, provider accounts,
companies, workspaces, repositories, and remote environments without rebuilding the execution
infrastructure that T3 Code already provides.

Axis is intentionally **not** a rewrite or wholesale rename of T3 Code. T3 remains the execution
plane. Axis adds product and organizational concepts around it.

## Product boundary

### T3 owns

T3 remains authoritative for:

- agent execution and runtime lifecycle
- provider drivers/adapters and provider-native protocol handling
- Claude Code, Codex, Cursor, Grok, OpenCode, Antigravity, and future T3 provider integrations
- terminal execution
- filesystem and file access
- Git operations, diffs, checkpoints, and worktrees
- remote transport and environment connectivity
- desktop, web, and mobile shell infrastructure
- connection runtime and reconnect behavior
- permissions and provider approval plumbing
- projects, threads, turns, and base provider-session mechanics
- the base orchestration event log, command handling, projections, and reactors

Axis code must reuse these facilities instead of creating parallel implementations.

### Axis owns

Axis adds product-specific concepts and workflows:

- Companies
- Workspaces
- organization of multiple provider instances/accounts
- Work Hub and task-oriented views
- Calendar
- Shared Memory across agents/providers
- Agent Sessions as Axis metadata/domain, not as a replacement for T3 threads or provider sessions
- cross-agent orchestration
- notifications derived from execution and product state
- Axis-specific remote-control UX
- cross-environment product organization and aggregation

## Core model

T3's operational hierarchy remains intact:

```text
environment
  -> project
    -> thread
      -> turn
```

Axis layers organizational metadata over those objects rather than replacing them. Conceptually:

```text
company
  -> workspace
    -> references one or more T3 environments/projects
    -> maps allowed/default provider instances
    -> owns Axis product metadata

axis agent session
  -> references a T3 thread
  -> may reference an Axis workspace, orchestration run, task, memory context, or other Axis metadata
```

A T3 `ProviderDriverKind` identifies an implementation. A T3 `ProviderInstanceId` identifies a
configured runtime/account instance. Axis account organization should therefore map business
metadata to provider instance IDs instead of introducing another provider runtime abstraction.

## Architectural rules

1. Prefer additive Axis modules over edits to existing T3 modules.
2. Do not rename T3 internals such as package names, `.t3`, `T3CODE_HOME`, imports, or runtime
   concepts unless a product requirement makes the change unavoidable.
3. Anything crossing the T3 client/server wire still uses `packages/contracts`.
4. Shared web/mobile connection and domain behavior belongs in `packages/client-runtime`.
5. Provider-specific complexity remains behind T3 provider adapters and drivers.
6. Axis orchestration invokes T3 commands and consumes T3 events; it does not call provider CLIs
   directly.
7. Axis Agent Sessions reference T3 threads/sessions; they do not duplicate their lifecycle.
8. Environment-owned Axis data may use the existing server persistence stack. Global Axis data must
   have an explicit owner and sync model before implementation.
9. Any edit to a T3-owned hotspot must explain why an external/additive extension point was
   insufficient.
10. Contract/runtime changes must consider web, desktop, mobile, local, and remote clients.
11. Persisted event compatibility is a long-lived constraint. Never make replay of existing T3
   history depend on a new Axis-only assumption.
12. Port capabilities from the legacy Axis, not its implementation or visual structure by default.

## Extension namespaces

When Axis code is introduced, prefer these locations where applicable:

```text
apps/server/src/axis/
packages/contracts/src/axis/
packages/client-runtime/src/axis/
apps/web/src/axis/
apps/mobile/src/axis/
apps/desktop/src/axis/        # only for native Electron/IPC needs
```

These are conventions, not permission to duplicate an existing T3 abstraction. Integration seams
will still require small changes to T3-owned composition roots, RPC registration, navigation, or
migration registries. Keep those edits narrow and make the Axis dependency obvious.

See [AXIS_ARCHITECTURE.md](./AXIS_ARCHITECTURE.md) for the detailed dependency model,
[T3_UPSTREAM.md](./T3_UPSTREAM.md) for upstream maintenance rules, and
[MIGRATION_FROM_AXIS_LEGACY.md](./MIGRATION_FROM_AXIS_LEGACY.md) for migration policy.

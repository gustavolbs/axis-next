# Axis

## Status

Axis Next is a long-lived fork of T3 Code. T3 Code is the workstation and agent-runtime foundation; Axis is the control plane and product layer built on top of it.

The fork intentionally keeps T3 naming, packages, runtime concepts, and infrastructure intact unless an Axis capability cannot be implemented through an extension point. Axis is not a T3 rewrite and broad rebranding is explicitly out of scope.

## Product goal

Axis should be one application for controlling multiple AI agents, provider accounts, companies, workspaces, repositories, and work contexts while reusing T3's execution infrastructure.

A representative hierarchy is:

```text
Company
└── Axis Workspace
    ├── Repository bindings
    ├── Provider/account assignments
    ├── Axis Agent Sessions
    ├── Shared Memory
    ├── Work Hub data
    ├── Calendar / tasks
    └── Orchestration policies and runs
```

This hierarchy is Axis metadata and organization. It must not replace T3's runtime models.

## Ownership boundary

### T3 owns

T3 remains authoritative for:

- agent execution and provider runtime;
- provider drivers/adapters, including Claude Code, Codex, and other T3-supported providers;
- terminal execution;
- filesystem access and file reading/writing;
- Git, diffs, checkpoints, and worktrees;
- remote transport and connection runtime;
- desktop, web, and mobile shell infrastructure;
- permission plumbing and provider approvals;
- base thread/session mechanics;
- the canonical orchestration event log, command dispatch, provider ingestion, and runtime projections.

Axis code may consume these capabilities and may attach metadata to their identifiers. It must not create parallel implementations without a documented architectural reason.

### Axis owns

Axis is authoritative for:

- Companies;
- Axis Workspaces;
- organization and assignment of provider instances/accounts to Axis scopes;
- Work Hub;
- Calendar and Axis tasks;
- Shared Memory across agents/providers;
- Axis Agent Sessions as a metadata/domain layer;
- cross-agent coordination policies and workflows;
- notifications and notification policy;
- Axis-specific remote-control UX;
- the product experience that composes the capabilities above.

## Vocabulary

T3 and Axis use some words that are close but are not interchangeable.

### T3 project vs Axis Workspace

T3's project/filesystem contracts are rooted in runtime working directories and repository/project operations. An **Axis Workspace** is a business/product organizational scope belonging to a Company. It may bind one or more repositories or T3 project roots.

Code should prefer explicit Axis names such as `AxisWorkspaceId` where ambiguity is possible.

### T3 Thread vs Axis Agent Session

A **T3 Thread** is the authoritative execution/conversation aggregate.

An **Axis Agent Session** is Axis-owned metadata around an agent working context. The initial model should reference a T3 `ThreadId` rather than copying thread state. Cross-agent orchestration may group several Axis Agent Sessions later; that does not turn Axis Agent Session into a replacement thread engine.

### Provider driver vs provider instance vs Axis provider account

T3 distinguishes a provider driver implementation from a `ProviderInstanceId`. Multiple instances of the same driver are already supported and may have independent configuration/environment.

An Axis provider/account record, if needed, is therefore an organizational mapping to a T3 `ProviderInstanceId` plus Axis metadata such as Company/Workspace assignment, label, purpose, or policy. Authentication/execution remains T3-owned.

## Architectural invariants

1. **T3 runtime state stays authoritative.** Axis references T3 identifiers and projections instead of mirroring execution state.
2. **Axis depends on T3, not the reverse.** T3 core modules should not import Axis product modules.
3. **Prefer additive namespaces.** New Axis server/client/domain code belongs in Axis-specific folders/packages.
4. **Do not fork transports.** Axis uses the existing T3 connection/runtime path for desktop, web, and mobile.
5. **Do not fork orchestration infrastructure.** Axis cross-agent orchestration coordinates through the existing T3 orchestration engine/event lifecycle.
6. **Do not rebuild multi-account runtime.** Axis organizes T3 provider instances.
7. **Use the existing persistence platform.** Axis data should share the server persistence environment while keeping Axis-owned schema/services isolated where possible.
8. **Shared contracts are cross-platform by default.** Any Axis contract exposed through the server must be considered for web, desktop, and mobile consumers.
9. **Central T3 edits require justification.** A change in an upstream-owned hotspot must document why composition or an Axis-side adapter was insufficient.
10. **No broad renaming.** Existing T3 package names, imports, environment variables, storage paths, and internal identifiers remain unchanged unless a concrete product requirement demands otherwise.

## Non-goals

The Axis fork does not aim to:

- recreate VS Code or another general-purpose IDE;
- reproduce the legacy Axis UI pixel-for-pixel;
- replace T3's terminal/filesystem/Git/remote infrastructure;
- introduce a second thread/session model for execution;
- introduce a second provider registry;
- introduce a second event log for the same runtime lifecycle;
- rename T3 internals merely to make the fork look branded.

## Legacy migration rule

No legacy Axis component should be copied before it is classified as one of:

- `KEEP` — capability/design survives essentially as-is;
- `PORT` — Axis-owned capability should be reimplemented on the new foundation;
- `MERGE` — useful Axis behavior should be combined with an existing T3 capability;
- `REPLACE_WITH_T3` — T3 already owns the capability and the legacy implementation should not return;
- `DELETE` — obsolete or unnecessary capability/debt.

See [MIGRATION_FROM_AXIS_LEGACY.md](./MIGRATION_FROM_AXIS_LEGACY.md).

## Related documents

- [AXIS_ARCHITECTURE.md](./AXIS_ARCHITECTURE.md) — target architecture, extension points, and implementation roadmap.
- [T3_UPSTREAM.md](./T3_UPSTREAM.md) — upstream synchronization and conflict policy.
- [MIGRATION_FROM_AXIS_LEGACY.md](./MIGRATION_FROM_AXIS_LEGACY.md) — legacy classification and migration rules.

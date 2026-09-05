# Axis Architecture

## Purpose

This document defines how Axis-specific capabilities should extend T3 Code without turning the fork into a divergent rewrite.

The architectural direction is:

```text
Desktop / Web / Mobile
        │
        ▼
Existing T3 connection/runtime contracts
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│                       Server                             │
│                                                          │
│  Axis control plane              T3 execution platform   │
│  ─────────────────               ─────────────────────   │
│  Companies                       Threads / sessions      │
│  Axis Workspaces        ───────► Provider instances      │
│  Provider assignments            Orchestration engine    │
│  Axis Agent Sessions    ───────► Event log/projections   │
│  Shared Memory                   Filesystem / terminal    │
│  Work Hub               ───────► Git / checkpoints       │
│  Calendar / tasks                Permissions             │
│  Cross-agent policies   ───────► Remote/runtime          │
│  Notifications                                           │
└──────────────────────────────────────────────────────────┘
```

The arrows are intentional: Axis consumes, references, and commands T3-owned infrastructure. T3 core must not require Axis to function.

## Current T3 architecture relevant to Axis

### Authoritative server

The server is the authoritative runtime boundary. It owns provider execution, orchestration command processing, event persistence/projections, projects/workspaces, filesystem, terminal, Git/checkpoints, relay/remote infrastructure, and provider session runtime.

This makes the server the correct integration point for Axis domain services. Axis clients should not coordinate providers directly.

### Orchestration engine and lifecycle

T3 exposes an explicit `OrchestrationEngineService`. It validates and dispatches commands, serializes command execution, deduplicates command receipts, updates in-memory read models, replays persisted events, exposes global/thread event reads, and provides hot domain-event subscriptions.

The durable `OrchestrationEventStore` owns append/replay of canonical orchestration events. Projection services reduce this lifecycle into thread/session/activity/message/approval/turn/project read models.

**Axis implication:** cross-agent orchestration is a coordinator/policy layer over this engine and its lifecycle. Axis must not create a competing runtime event log for T3 execution events.

### Provider instances

T3 deliberately separates provider driver kind from `ProviderInstanceId`. The registry can host multiple instances backed by the same driver with independent configuration/environment and hot-reloads changed instances.

**Axis implication:** multiple Claude/Codex accounts should be represented by T3 provider instances. Axis adds organization and assignment metadata; it does not add a second provider runtime registry.

### Project/filesystem model

T3 project contracts are runtime/filesystem oriented and rooted in a working directory/workspace root.

**Axis implication:** an Axis Workspace is a different domain concept. It is an organizational scope under a Company and binds repository/project roots rather than replacing T3 project semantics.

### Connection runtime and clients

Web, desktop, and mobile depend on the shared T3 contracts/client runtime. Direct/local and remote modes are connection concerns below product features.

**Axis implication:** product features should use the same transport path on all clients. Axis-specific remote control is UX/policy layered on T3 remote infrastructure.

## Domain relationships

The initial Axis domain should converge on these references:

```text
Company
└── AxisWorkspace
    ├── RepoBinding ───────────────► T3 project/root/cwd identity
    ├── ProviderAssignment ────────► ProviderInstanceId
    ├── AxisAgentSession ──────────► ThreadId + ProviderInstanceId
    ├── SharedMemory scope
    ├── WorkHub projections
    ├── Calendar / Task records
    └── Orchestration definitions/runs
```

Important constraints:

- Company and Axis Workspace are Axis-owned aggregates.
- Repo bindings reference a T3/runtime repository root; they do not duplicate filesystem state.
- Provider assignments reference `ProviderInstanceId`.
- The first Axis Agent Session model should reference one authoritative T3 `ThreadId` and add only Axis metadata. If a later orchestration workflow spans many threads, model that as a separate Axis orchestration/run aggregate.
- Shared Memory may be scoped by Company, Axis Workspace, repository binding, and optionally Axis Agent Session, but runtime thread messages are not themselves copied into memory by default.

## Extension points

### 1. Provider organization — `ProviderInstanceRegistry`

Use the existing registry to resolve/list provider instances and react to registry changes.

Axis should add:

- account/display metadata only when T3 configuration is insufficient for product organization;
- Company/Workspace assignments;
- default/preferred provider-instance policies by Axis scope.

Axis should not add:

- provider process lifecycle;
- provider authentication execution;
- a parallel adapter registry;
- a parallel `session -> provider` routing layer.

### 2. Cross-agent coordination — `OrchestrationEngineService`

Use engine command dispatch to perform T3-owned runtime actions and subscribe to domain events to advance Axis-owned workflows.

Axis orchestration should own higher-level concepts such as:

- workflow/run metadata;
- dependency/order policy between agent sessions;
- handoff context;
- decision gates;
- retry/escalation policy at the product level.

It should not own provider process management, command receipt semantics, base thread state, or event transport.

### 3. Work Hub and notifications — projections + event lifecycle

Work Hub should be a composed read model from:

- Axis Company/Workspace/Agent Session metadata; and
- T3 thread/session/activity/approval/turn projections.

Notifications should react to canonical lifecycle transitions (finished, failed, approval required, decision required where represented) and Axis workflow events. They should not infer state by polling provider processes independently.

### 4. Axis persistence — existing server persistence environment

Axis should use the same persistence environment/database as the server while isolating Axis-owned repositories and tables.

Preferred table naming is explicit, for example `axis_companies`, `axis_workspaces`, and similar names, rather than modifying T3 projection tables.

The current T3 migration manifest is a conflict hotspot because migrations are statically imported and sequentially enumerated. Before the first Axis schema migration, investigate a separate Axis migration loader/namespace on the same database. If the underlying migrator cannot safely isolate migration history, use the smallest possible central registration change and document the reason in the PR.

### 5. API/transport — existing connection runtime

Axis server APIs must travel through the established server/client connection path. Do not add a special local-only API that bypasses remote mode.

When new shared wire contracts are required, prefer an Axis-owned package rather than repeatedly editing broad upstream contract barrels.

### 6. Client product surfaces

Web and mobile should receive Axis feature namespaces. Desktop should contain Axis-specific code only for native integration that cannot live in the shared web/client layer.

Do not duplicate the same business logic separately across desktop/web/mobile.

## Proposed code placement

The target layout is additive:

```text
packages/
└── axis-contracts/
    └── src/
        ├── company.ts
        ├── workspace.ts
        ├── providerAccount.ts
        ├── agentSession.ts
        ├── memory.ts
        ├── workHub.ts
        ├── calendar.ts
        ├── orchestration.ts
        └── notifications.ts

apps/server/src/
└── axis/
    ├── domain/
    ├── application/
    ├── persistence/
    └── integration/
        ├── orchestration/
        ├── providers/
        └── runtime/

apps/web/src/features/
└── axis/

apps/mobile/src/features/
└── axis/

apps/desktop/src/
└── axis/                 # native-only integration when required
```

This is a direction, not permission to create all folders eagerly. Create modules only when a PR needs them.

### Why a separate `axis-contracts` package

The workspace already discovers `packages/*`. An Axis-owned package provides a clear dependency boundary and reduces routine edits to T3's central contracts package/indexes.

The package should still reuse T3 contract types such as `ThreadId` and `ProviderInstanceId`; it is not an alternate RPC/runtime contract universe.

A separate Axis client-runtime package should **not** be created preemptively. Add one only if meaningful shared Axis client behavior emerges across web/mobile/desktop that cannot remain in thin feature adapters.

## Dependency rules

Allowed:

```text
Axis domain/contracts ─────► selected T3 contract types
Axis server integration ───► T3 server services
Axis features ─────────────► Axis contracts + existing T3 client/runtime APIs
```

Disallowed by default:

```text
T3 provider core ──────────► Axis domain
T3 orchestration core ─────► Axis workflows
T3 connection runtime ─────► Axis product state
T3 projections ────────────► Axis tables
```

If a disallowed dependency becomes necessary, the PR must explain why an external adapter/composition hook cannot solve the problem.

## Cross-platform contract rule

Any Axis capability that affects shared runtime behavior must be reviewed against all three clients:

- web;
- desktop;
- mobile.

A feature may intentionally ship UI on one client first, but its wire contract and server semantics must not assume that client is the only consumer.

## Upstream conflict risk map

### Low risk

- new `docs/AXIS*.md` documents;
- new `packages/axis-*` packages;
- new `apps/server/src/axis/**` modules;
- new Axis feature folders in clients;
- Axis-owned tests next to Axis modules.

### Medium risk

- app route/navigation registries;
- app/server composition roots and Effect layer assembly;
- workspace package manifests/lockfile;
- settings surfaces;
- native desktop/mobile capability registration.

### High risk

- `packages/contracts` central orchestration/provider/RPC definitions;
- `packages/client-runtime` connection internals;
- provider drivers/registry internals;
- `OrchestrationEngineService` implementation;
- persistence migration manifest;
- canonical projections;
- remote transport;
- base thread/session state machines.

High-risk edits require an explicit extension-point justification.

## Technical roadmap

The dependency order remains close to the initial product plan because the T3 codebase already provides the required lower-level primitives.

### PR #1 — Establish Axis fork architecture

Docs and boundaries only. No runtime behavior.

### PR #2 — Companies + Axis Workspaces

Introduce the first Axis contracts/domain/persistence path and validate the clean extension architecture. Include repository bindings only to the minimum necessary for workspace identity; do not rebuild project/filesystem infrastructure.

### PR #3 — Provider/account organization

Map Axis provider-account/assignment metadata to existing `ProviderInstanceId` values. Reuse `ProviderInstanceRegistry` for runtime availability and routing.

### PR #4 — Axis Agent Sessions

Add Axis session metadata referencing authoritative T3 `ThreadId`/provider instance/workspace context. Do not copy thread lifecycle state.

### PR #5 — Shared Memory

Introduce scoped memory after Company/Workspace/Repo/Session identities exist. Memory retrieval/injection should be provider-independent and should not replace T3 thread history.

### PR #6 — Work Hub

Build a composed read model from Axis metadata plus existing T3 projections/events. Avoid a parallel execution-state store.

### PR #7 — Calendar and task foundation

Add Axis calendar/task domain and UI. Keep external-calendar integrations separate from the core domain if/when introduced.

### PR #8 — Cross-agent orchestration

Add Axis workflow/run coordination on top of `OrchestrationEngineService`; no second orchestration engine/event log.

### PR #9 — Notifications

React to T3 lifecycle plus Axis workflow events. Reuse platform-native capabilities (the mobile app already includes notification support) and keep delivery policy Axis-owned.

### PR #10 — Remote Control / Mobile UX

Add Axis-specific control surfaces on top of existing T3 connection/remote infrastructure. Do not introduce a parallel remote transport.

### PR #11 — Legacy Axis migration

Migrate data/capabilities only after target domains are stable and every legacy component has been classified.

Small follow-up PRs are preferred whenever one of these scopes becomes too broad. The roadmap numbers describe dependency milestones, not a requirement for oversized pull requests.

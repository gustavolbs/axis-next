# Axis Architecture

This document describes how Axis extends T3 Code without turning the fork into a second agent harness.

## Architectural diagnosis

T3 is already organized around the boundaries Axis needs.

At runtime, a T3 **environment** owns provider processes, filesystem state, Git state, durable orchestration state, and credentials/configuration used by provider instances. Web, desktop, and mobile are clients of that environment over authenticated RPC. Remote access changes reachability, not execution ownership.

Inside the server, agent work is event-sourced:

```text
client RPC
  -> command
  -> pure orchestration decider
  -> persisted event + projection + command receipt
  -> post-commit reactors
  -> provider/filesystem/checkpoint side effects
  -> normalized runtime events
  -> projections/subscriptions
  -> clients
```

Provider implementations are deliberately behind adapters. T3 already distinguishes a provider **driver** from a provider **instance**, and routes thread/session state through instance IDs. This is especially important for Axis because multiple accounts of one provider do not require a new execution model.

`packages/contracts` is the versioned wire boundary. `packages/client-runtime` owns shared connection/session/data-lifetime logic so web and mobile do not invent separate reconnect or cache behavior. The desktop renderer follows the same client/server boundary even though Electron can also host the server.

The result is that Axis should be implemented mainly as an additive domain layer plus a small number of composition points.

## Core dependency rule

Dependencies should point inward toward stable T3 capabilities:

```text
Axis product UI
  -> Axis client domain/runtime
  -> Axis contracts
  -> Axis server domain
  -> T3 services / orchestration / provider instances
  -> T3 provider adapters and host infrastructure
```

T3 core must not depend on Companies, Workspaces, Work Hub, Shared Memory, or other Axis product concepts unless a narrow integration hook is unavoidable and generally belongs at composition time.

## Domain model boundaries

### Company and Workspace

Axis introduces:

```text
Company
  -> Workspace
      -> bindings to one or more T3 Projects / repositories
      -> eligible Provider Accounts
      -> Axis product state
```

A Company is an identity/isolation boundary. A Workspace is a logical product grouping. Neither is inferred from `cwd`, project display name, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, provider label, or environment endpoint.

T3 Projects remain the execution/filesystem primitive. Axis stores associations to them rather than adding Company fields throughout T3's project implementation.

### Provider, Provider Account, authentication, and runtime

Axis must model four independent dimensions:

```text
Provider
  Anthropic | OpenAI | OpenRouter | ...

ProviderAccount
  Claude Personal | Live Nation Claude | OpenAI API Work | ...

AuthenticationConfiguration
  OAuth | API Key | enterprise/managed | env | custom endpoint | ...

RuntimeConfiguration
  Claude Code | Codex | OpenCode | another T3 driver
```

The execution bridge is a mapping, not inheritance:

```text
ProviderAccount
  -> AuthenticationConfiguration
  -> RuntimeConfiguration
  -> ProviderInstanceId + ProviderInstanceConfig
  -> ProviderAdapter
```

`ProviderInstanceId` remains T3's routing identity. Axis stores its own `ProviderAccountId` and a binding between them. This prevents the product model from becoming coupled to Claude or Codex implementation details.

A single Provider Account normally maps to one active provider instance in one environment. The design should still allow rematerialization if runtime configuration changes, migration between compatible drivers, or environment-local instance IDs differ.

### Axis Agent Session

An Axis Agent Session is metadata around execution, not a second provider session.

It should reference existing T3 identifiers such as environment, project, thread, turn/session/provider-instance IDs where available and add Axis provenance such as:

- Company ID;
- Workspace ID;
- Provider Account ID;
- orchestration parent/child relationship;
- memory provenance;
- notification state;
- Axis workflow metadata.

The Axis record must not duplicate the full T3 conversation/event history.

## Best extension points

### 1. Provider-instance configuration and registry

T3's provider-instance model is the primary execution extension point for Provider Accounts. It already separates driver kind from instance identity and supports instance-specific config/environment.

Axis should resolve a trusted Provider Account into a T3 instance configuration and let T3 own process/session execution.

Do not add provider-account semantics inside every adapter. Adapter changes are justified only when the existing driver cannot accept a configuration that its underlying runtime legitimately supports.

### 2. Server Effect composition

Axis server services should live under `apps/server/src/axis/` and be composed with existing T3 services at server startup.

Examples:

- Company/Workspace repositories;
- account materialization service;
- Agent Session projector/listener;
- memory ingestion service;
- notification listener;
- Work Hub collectors.

This is preferable to adding Axis branches to the orchestration decider, provider service, or checkpoint reactor.

### 3. T3 orchestration events and projections

Axis should consume the durable T3 orchestration model wherever possible.

Good uses include:

- deriving session status;
- detecting completion/failure;
- observing permission/decision waits;
- building memory inputs from normalized/redacted activity;
- attaching Axis metadata to existing execution;
- coordinating child runs using normal T3 commands.

Axis must not create a competing event log for the same execution lifecycle.

A T3 orchestration schema change is justified only when Axis needs an invariant that cannot be reconstructed reliably outside the T3 transaction. Any such change must preserve replay compatibility and be documented as an intentional upstream touchpoint.

### 4. Additive RPC contracts

Axis will need commands and subscriptions. Prefer Axis-owned schemas and additive transport registration.

The long-term direction is an Axis contracts namespace/package rather than filling generic T3 domain files with Company/Work Hub types. However, T3's central RPC registry is the actual wire boundary, so a small registration change there may be unavoidable.

The rule is: Axis domain type definitions stay outside hot T3 files; hot files contain only the minimum import/registration glue.

### 5. Shared client runtime

Axis features visible on multiple surfaces should share state and transport behavior. The intended layer is `packages/axis-client-runtime`, consuming T3's `packages/client-runtime` environment connection registry rather than replacing it.

Examples:

- Company/Workspace catalogs aggregated across connected environments;
- Axis subscriptions;
- Work Hub normalized caches;
- notification state;
- session metadata.

Platform-specific services remain supplied by web/mobile/desktop as needed.

### 6. Axis UI namespaces

Product UI should be grouped under `apps/web/src/axis/` and `apps/mobile/src/axis/`. Desktop-specific Axis code belongs under `apps/desktop/src/axis/` only for native Electron responsibilities.

Do not fork shared T3 chat/thread UI wholesale. Compose Axis navigation, selectors, metadata, and new surfaces around existing components where practical.

### 7. SQLite persistence

T3 has one environment-local SQLite persistence layer and a central static migration manifest. Axis data that must be authoritative for execution/isolation should normally remain server/environment-owned and may use Axis-owned tables in that database.

Future migrations should keep table names and repository code Axis-specific. Registering the migration in T3's central manifest is an expected thin integration point.

Do not add Axis columns to high-churn T3 projection tables merely because it is convenient. Prefer separate tables keyed by stable T3 IDs unless atomic co-commit with T3 state is a proven requirement.

## Multi-environment architecture

A client can connect to multiple T3 environments. Axis must preserve T3's rule that execution and authoritative machine state stay in the owning environment.

Axis federation therefore has two layers:

1. **Environment authority** — Company/Workspace/account bindings that affect execution, Agent Session metadata, memory owned by repos in that environment, and other security-relevant state are served by the environment that owns the T3 Project/runtime.
2. **Client aggregation** — the Axis client may merge safe snapshots from several connected environments into one Company/Workspace/Work Hub view. That aggregation does not grant execution authority to the client or move secrets between environments.

A future cloud synchronization service, if introduced, must not silently become the owner of provider credentials or local execution state. That would be a separate architecture decision.

## Secrets and credential boundary

Axis account metadata and secret material must be separated.

Conceptually:

```text
ProviderAccount record
  id
  provider
  displayName
  authKind
  secretRef?       # opaque reference only
  runtime config   # non-secret configuration
  status metadata

trusted secret store
  secretRef -> API key/token material
```

The current T3 code already has provider-instance environment entries marked sensitive/redacted and desktop code that deliberately requires protected OS credential backends on Linux. Those are useful building blocks, but they do not by themselves define the final Axis secret-at-rest model.

PR 3 must trace the complete path from UI entry to persisted settings, RPC responses, logs, process environment, and deletion. A value marked `sensitive` must never be assumed safe simply because the UI redacts it.

Required invariants:

- no plaintext API key/token in Axis SQLite tables;
- no plaintext secret in normal provider-account RPC responses;
- no secret round-trip to web/mobile after creation;
- no secret in structured logs, errors, telemetry, or memory;
- secret resolution occurs in the trusted environment immediately before runtime configuration/process launch;
- account deletion removes or revokes its secret reference where supported;
- auth status is represented separately from secret content;
- unsupported auth/runtime combinations fail closed.

## Proposed module structure

Modules are created only as implementation arrives.

```text
apps/server/src/axis/
  companies/
    Services/
    Layers/
  workspaces/
    Services/
    Layers/
  accounts/
    Services/
    Layers/
  agentSessions/
  memory/
  workHub/
  calendar/
  orchestration/
  notifications/

packages/axis-contracts/
  src/company.ts
  src/workspace.ts
  src/providerAccount.ts
  src/agentSession.ts
  src/memory.ts
  src/workHub.ts
  src/notifications.ts

packages/axis-client-runtime/
  src/environment/
  src/state/
  src/accounts/
  src/workHub/
  src/notifications/

apps/web/src/axis/
  components/
  routes/
  state/

apps/mobile/src/axis/
  components/
  screens/
  state/

apps/desktop/src/axis/
  credentials/   # only if OS/native secret integration belongs in Electron
  native/        # other Axis-only host integrations
```

This is a direction, not a mandate to create one package per concept. If the first implementations remain small, co-locate until separation produces a real ownership/versioning benefit.

## Hot upstream files and expected conflict points

The following are high-risk because upstream naturally changes them frequently:

- `packages/contracts/src/rpc.ts` and central exports;
- `packages/contracts/src/orchestration.ts`;
- orchestration decider/projector/engine/reactors;
- `apps/server/src/ws.ts` and server composition/startup;
- provider registry and server settings;
- `apps/server/src/persistence/Migrations.ts`;
- global web/mobile navigation and layout roots;
- client-runtime connection registry internals;
- desktop bootstrap/IPC contracts.

Axis logic should not live in those files. When a touch is unavoidable, keep it to imports, registration, or composition and put behavior behind an Axis-owned interface.

## When modifying T3 core is acceptable

A T3 core modification requires one of these reasons:

- there is no stable service/event/adapter boundary exposing the required capability;
- correctness requires atomicity with a T3 transaction/event;
- the feature is inherently a cross-surface wire capability and must be registered in T3's central RPC contract;
- the provider driver does not expose configuration that the underlying runtime supports and no external composition path exists;
- a generally useful T3 bug/extension point should ideally be contributed upstream.

The PR description must state which reason applies and why an Axis-only extension was insufficient.

## Legacy architecture decision

The previous Axis built substantial execution infrastructure: its own agent runtime composition, tool abstraction, filesystem/process/Git handling, security policy, provider routing, and desktop orchestration. Under Axis Next, those areas are not reference implementations to copy. They are evidence of product requirements.

Port the requirement only after deciding whether T3 already satisfies it. See [MIGRATION_FROM_AXIS_LEGACY.md](./MIGRATION_FROM_AXIS_LEGACY.md).

## Cross-surface checklist

Any Axis change touching shared runtime or transport must explicitly evaluate:

- server/environment ownership;
- hosted/local web;
- desktop renderer and Electron host responsibilities;
- iOS/Android mobile;
- local, SSH, Tailscale, relay/tunnel connection modes;
- mixed-version client/server behavior;
- offline cached state and reconnect behavior;
- provider-instance compatibility;
- persisted-event/database migration compatibility.

A feature is not complete merely because it works in the desktop renderer.
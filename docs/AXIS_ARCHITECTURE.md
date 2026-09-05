# Axis Architecture

Axis extends T3 Code without replacing its execution model. This document defines the dependency
boundaries that should keep the fork maintainable while Axis grows into a multi-company,
multi-workspace, multi-provider control surface.

## T3 architecture we are building on

T3 Code is an environment-owned execution system with multiple clients.

```text
web / desktop renderer / mobile
             |
      authenticated RPC
             |
        T3 environment
             |
  +----------+-----------+
  |          |           |
projects  orchestration  providers
  |          |           |
files/git  event log   adapters/CLIs
             |
        projections
```

Important properties of that system:

- The environment owns filesystem state, provider credentials, projects, threads, terminals, Git,
  and durable execution state.
- Clients connect to environments. Remote connectivity changes the route, not execution ownership.
- `packages/contracts` is the versioned client/server boundary.
- `packages/client-runtime` owns shared connection and synchronized client state used by web and
  mobile.
- T3 orchestration is event-sourced: commands are decided into events, events and projections are
  persisted transactionally, and reactors perform side effects after durable intent exists.
- Provider-native behavior is normalized at the adapter/driver boundary.
- A provider driver identifies an implementation; a provider instance identifies a configured
  account/runtime instance and is already the routing key used by threads and sessions.

These are platform primitives for Axis, not migration targets.

## Axis architecture

Axis should behave as a product/control layer over one or more T3 environments.

```text
                    AXIS PRODUCT LAYER

 company -> workspace -> product context / policy / organization
                 |                  |
                 |                  +-> memory / work hub / calendar
                 |                  +-> orchestration / notifications
                 |
          stable T3 references
                 |
       +---------+----------+
       |                    |
 environment A          environment B
       |                    |
 project/thread         project/thread
 provider instance      provider instance
       |                    |
       +-------- T3 execution plane --------+
```

The central rule is that Axis may **reference, group, enrich, coordinate, and present** T3 runtime
objects. It should not reimplement them.

## Identity and reference model

Axis entities that point to T3 resources must retain enough identity to avoid accidental
cross-environment routing.

Prefer explicit references conceptually shaped like:

```ts
type AxisProjectRef = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
};

type AxisThreadRef = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
};

type AxisProviderInstanceRef = {
  environmentId: EnvironmentId;
  providerInstanceId: ProviderInstanceId;
};
```

The exact schemas should be introduced only with the feature that needs them. Do not infer an
environment from a project, thread, or provider instance ID when the data can cross environment
boundaries.

## Data ownership: environment-local vs Axis-global

This is the most important unresolved decision before Companies and Workspaces are implemented.

T3's durable state belongs to one environment. Axis concepts such as a Company may need to contain
projects from several environments and must eventually appear consistently on desktop, web, and
mobile. Therefore every Axis record must first be classified by ownership.

### Environment-owned Axis data

Data is environment-owned when it only describes resources and behavior inside that environment.
Examples may include execution-adjacent metadata or projections that can be reconstructed entirely
from that environment.

For this data:

- use the existing server SQLite/persistence infrastructure;
- prefer Axis-specific tables/repositories and migrations;
- do not create another SQLite file, event store, or migration runner merely to isolate the namespace;
- expose it through the normal typed RPC boundary when clients need it.

### Axis-global data

Data is Axis-global when it must group or coordinate resources from multiple environments or remain
consistent across client devices independently of any one environment. Companies and Workspaces are
likely to fall into this category.

Do not make one arbitrary T3 environment the implicit global owner. Before PR #2, choose and
document a storage/sync owner. The design should support stable references to T3 resources without
moving their execution state out of their environment.

Possible implementations can be evaluated later; PR #1 intentionally does not create a control
plane prematurely.

## Extension points

### Server: `apps/server/src/axis/`

Use for Axis server-side domain/application logic that truly belongs to an environment.

Potential future shape:

```text
apps/server/src/axis/
  accounts/
  agentSessions/
  memory/
  orchestration/
  notifications/
  persistence/
```

Do not move T3 provider, project, thread, filesystem, Git, permission, or checkpoint code here.
Axis modules should depend on T3 services through their existing boundaries.

### Contracts: `packages/contracts/src/axis/`

Use only for Axis schemas/types/RPC payloads that cross process or client/server boundaries.

Potential future shape:

```text
packages/contracts/src/axis/
  references.ts
  companies.ts
  workspaces.ts
  agentSessions.ts
  memory.ts
  workHub.ts
  calendar.ts
  orchestration.ts
  notifications.ts
```

This namespace is not a second RPC system. Axis RPC methods must still be registered through T3's
existing contract/RPC mechanism and capability/versioning rules.

### Shared client runtime: `packages/client-runtime/src/axis/`

Use for product state that must behave identically on web and mobile: multi-environment aggregation,
caching, subscriptions, and higher-level selectors.

Potential future shape:

```text
packages/client-runtime/src/axis/
  organization/
  accounts/
  agentSessions/
  memory/
  workHub/
  calendar/
  orchestration/
  notifications/
```

Do not add another connection manager or websocket client. Axis consumes environment registrations
and RPC sessions owned by T3 client-runtime.

### Web: `apps/web/src/axis/`

Use for Axis-specific React routes, screens, commands, navigation adapters, and presentation logic.
Reuse T3 components and shell primitives where they fit. Do not copy T3 chat/thread UI into an Axis
version just to change branding.

### Mobile: `apps/mobile/src/axis/`

Use for Axis-specific React Native navigation/screens and mobile interaction patterns. Shared state
and orchestration logic should remain in client-runtime rather than being reimplemented here.

### Desktop: `apps/desktop/src/axis/`

Create this namespace only for Axis functionality requiring native Electron/main-process/IPC
behavior. The desktop renderer uses the web application, so ordinary Axis UI should live in web.

## Integration seams

Some T3-owned files will inevitably be touched. These edits are allowed when they are narrow
composition points rather than alternate implementations.

Expected seams include:

- RPC method/schema registration in `packages/contracts`;
- server layer/bootstrap composition;
- the existing migration manifest for environment-owned Axis tables;
- web and mobile route/navigation registration;
- command palette/settings entry-point registration when relevant;
- capability advertisement if an Axis feature must work with independently versioned clients and
  servers.

Every central T3 edit should answer:

1. What Axis feature requires this integration?
2. Why can it not be implemented entirely in an additive Axis module?
3. Is the edit limited to registration/composition?
4. What happens on web, desktop, mobile, local, and remote clients?
5. What happens when client/server versions differ?
6. Does persisted T3 history remain replayable?

## Provider/account organization

T3 already models multiple accounts/configurations as provider instances. Axis must build on this.

Axis may add metadata such as:

- company/workspace assignment;
- user-facing account role or label;
- allowed/default instance policies;
- account grouping and filtering;
- product-level selection defaults.

Axis must not duplicate:

- provider authentication;
- provider config directories/homes;
- provider process ownership;
- model catalogs;
- adapter capabilities;
- provider session state;
- runtime event normalization.

Those remain T3 responsibilities.

## Axis Agent Sessions

An Axis Agent Session is a product/domain record around T3 work, not another execution session.

It may eventually attach metadata such as:

- company/workspace;
- one or more related T3 thread references;
- task/work-item association;
- orchestration-run association;
- memory/context scope;
- user-visible status or grouping not represented by the provider runtime.

It must not become the authority for provider process lifetime, approvals, turns, checkpoints, or
thread history.

## Shared Memory

Shared Memory should integrate with existing project/thread/provider identity and feed context into
agents through supported T3/provider extension seams. It must not require a second agent runtime or
fork each provider adapter merely to inject context.

Memory scope should be explicit. Likely scopes include company, workspace, repository/project, and
possibly agent-session/task. Environment identity must remain part of references whenever memory
points back to T3 state.

## Cross-agent orchestration

Axis orchestration is a coordinator above T3 orchestration.

It should:

- select target environment/project/thread/provider instances;
- dispatch normal T3 commands;
- observe persisted T3 execution events/projections;
- persist only Axis-specific workflow intent/state;
- derive waiting/finished/failed/needs-decision states from durable sources.

It should not:

- spawn Claude/Codex directly;
- duplicate T3 approvals or provider session lifecycle;
- fork the T3 event log;
- infer completion from UI state when a durable event/projection exists.

Cross-environment orchestration requires a durable coordinator with an explicit owner; do not hide
that requirement in a client component.

## Notifications

Notifications should be projections/reactions to durable state such as turn completion, failure,
pending approval, pending user input, or Axis workflow state. Provider-specific notification hooks
should be avoided when normalized T3 state can express the event.

## Dependency direction

Preferred dependency direction:

```text
Axis UI
  -> Axis client-runtime
    -> T3 client-runtime / contracts
      -> T3 RPC
        -> Axis server module (when applicable)
          -> existing T3 server services

Axis server module
  -> T3 project/thread/provider/orchestration services

T3 core
  -X-> Axis product modules
```

T3 core should not acquire broad knowledge of Companies, Workspaces, Work Hub, Calendar, or Shared
Memory. Where registration is required, keep it at composition roots.

## Upstream conflict risk

Highest-risk files are central registries/composition roots that upstream changes frequently:

- root workspace/build configuration;
- `packages/contracts/src/rpc.ts` and central exports;
- server bootstrap/layer composition;
- the migration manifest;
- provider registry/driver composition;
- top-level web/mobile navigation;
- desktop main/preload/IPC contracts.

Mitigations:

- add new Axis files instead of editing existing implementations;
- keep unavoidable edits small and mechanical;
- avoid formatting unrelated upstream code;
- do not rename packages or paths for branding;
- do not mix an upstream-core refactor with an Axis feature PR;
- synchronize upstream frequently before large Axis integration PRs.

## Technical roadmap

The original roadmap is directionally correct, but Companies/Workspaces require a global ownership
decision before implementation. The recommended sequence is:

1. **Fork architecture and boundaries** — this documentation-only foundation.
2. **Axis identity/storage decision + Companies/Workspaces foundation** — decide global ownership,
   define stable T3 references, then implement organization primitives.
3. **Provider account organization** — map Axis organization/policies onto T3 provider instances.
4. **Axis Agent Sessions metadata** — reference T3 threads without replacing session mechanics.
5. **Shared Memory foundation** — scopes, storage, retrieval/injection seam, provider-independent.
6. **Work Hub** — tasks/work items aggregated around Axis workspace/session references.
7. **Calendar** — calendar domain integrated with Work Hub rather than a disconnected scheduler.
8. **Cross-agent orchestration** — durable Axis workflow coordination using T3 commands/events.
9. **Notifications** — derive from T3 and Axis durable state.
10. **Remote Control / Mobile UX** — Axis-specific multi-environment/product control on top of T3
    connection runtime.
11. **Legacy Axis migration** — migrate only data/capabilities that survived the classification
    process.

PRs may be split further. In particular, storage/identity decisions should land before schema-heavy
Companies/Workspaces work if the implementation cannot keep the decision reversible.

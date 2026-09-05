# Axis architecture boundary

## Purpose

Axis organizes agent work across people, organizations, and providers, then adds higher-level
capabilities such as shared context and a unified work view. It uses T3 Code as its foundation
because T3 already provides the difficult execution infrastructure: provider processes, durable
agent conversations, filesystem and Git operations, checkpoints, permissions, remote connections,
and clients for web, desktop, and mobile.

Rebuilding those systems would create two sources of truth and repeat the failure modes that led to
the fork. The architectural boundary is therefore ownership, not branding:

- T3 owns execution infrastructure and its canonical operational records.
- Axis owns product-specific organization, policy, derived knowledge, and experiences.

## Existing T3 foundation

The boundary is based on the current code, not an aspirational model:

- [`ProviderDriver`](../../apps/server/src/provider/ProviderDriver.ts) separates an integration kind
  from a materialized provider instance. Instances own their adapter, account/configuration,
  snapshots, text generation, and lifecycle.
- [`ProviderInstanceRegistry`](../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts)
  routes by `ProviderInstanceId`, supports multiple configurations of one driver, and rebuilds only
  changed instances.
- [`providerInstance.ts`](../../packages/contracts/src/providerInstance.ts) keeps driver-specific
  configuration opaque, permits fork-specific driver slugs, and defines instance environment
  variables.
- [`serverSettings.ts`](../../apps/server/src/serverSettings.ts) stores sensitive instance variables
  in the environment secret store and redacts their values before settings reach a client.
- [`orchestration.ts`](../../packages/contracts/src/orchestration.ts) defines Projects, Threads,
  Turns, sessions, approvals, activities, checkpoints, commands, events, and read models shared over
  RPC.
- The [orchestration engine](../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts)
  commits durable intent. The [decider](../../apps/server/src/orchestration/decider.ts) is pure,
  reactors perform effects, and the [projector](../../apps/server/src/orchestration/projector.ts)
  derives client-facing state.
- The [event store](../../apps/server/src/persistence/Layers/OrchestrationEventStore.ts) and
  projection stores under `apps/server/src/persistence` are the canonical durable history and read
  model for agent work.
- [`packages/client-runtime`](../../packages/client-runtime/README.md) shares authenticated
  connection supervision, RPC, multi-environment scoping, and domain state between web and mobile.
  Desktop wraps the web client and adds host capabilities rather than bypassing the server boundary.

## Ownership

| T3 owns                                                                                               | Axis owns                                                                                       |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Provider drivers, instances, adapters, sessions, authentication, configuration, and process lifecycle | Context ownership, directional access grants, and policy across existing provider instance IDs  |
| Environment-local Projects and workspace roots                                                        | Personal/Company contexts and Workspaces that reference environment-scoped T3 Projects          |
| Threads, Turns, messages, activities, approvals, sessions, events, and checkpoints                    | Axis metadata attached to stable T3 identities and projections derived from T3 records          |
| Terminal, filesystem, Git, diffs, worktrees, and checkpoints                                          | Product workflows that invoke those existing capabilities                                       |
| Event-sourced command handling and provider orchestration                                             | Higher-level coordination expressed through T3 commands and observed through T3 events/receipts |
| Authenticated RPC, environment connections, relay/tunnel behavior, reconnects, and multi-client sync  | Axis presentation and product policy over the same connection runtime                           |
| Shared web/mobile client state primitives                                                             | Axis web, desktop, and mobile experiences composed from those primitives                        |

An Axis feature must not create an `AxisProvider`, `AxisProviderAccount`, `AxisProject`,
`AxisThread`, `AxisTerminal`, `AxisFilesystem`, `AxisRuntime`, or a second orchestration engine
merely to give an existing T3 concept an Axis name.

## Composition model

The intended relationship is additive:

```text
Axis account
├── Personal context (Axis isolation boundary)
│   ├── owned provider instances
│   └── Workspace (Axis) ──> T3 Projects in their environments
└── Company context (Axis isolation boundary)
    ├── owned or explicitly granted provider instances
    └── Workspace (Axis) ──> T3 Projects in their environments
        └── T3 Thread ──> T3 provider instance selection/session
```

T3 IDs are environment-local. Any Axis reference to a Project or Thread must therefore include the
environment identity as well as the T3 ID. A bare `projectId` or `threadId` is not a globally safe
foreign key.

### Personal, Companies, Workspaces, and provider access

Personal and each Company are peer context and isolation boundaries. A Company may use its own
provider instances and selected instances owned by Personal, but that access is an explicit,
directional grant. It does not merge the contexts or let Personal, Company A, and Company B see one
another's Projects, Threads, memory, MCP results, or Work Hub records.

A Workspace is an Axis grouping inside exactly one context. It holds references to T3 Projects,
scoped by environment, rather than replacing or copying them. Credentials remain in the T3
environment's settings and secret store, and execution still routes by `ProviderInstanceId`.

Provider access and capability access are separate. Reusing a personal subscription in a Company
does not implicitly import every personal MCP, skill, instruction, preference, memory, or provider
session. Selected portable personal capabilities may be granted separately; Company-owned
capabilities never flow to another context. A Company can also prohibit personal providers when its
policy requires company-managed accounts.

The full model, examples, and isolation invariants are in
[Contexts and provider access](./CONTEXTS.md). Profiles remain a possible future convenience for
grouping preferences and capabilities, not an execution runtime or isolation boundary.

### Axis metadata on Threads

Axis metadata should be stored as an extension record keyed by
`(contextId, environmentId, threadId)` unless a field is truly part of the generic T3 thread
lifecycle. Examples include Company/Workspace placement, Axis labels, Work Hub state, or
memory-processing cursors.

The T3 Thread remains canonical for title, project membership, model/provider-instance selection,
runtime and interaction modes, messages, activities, approvals, checkpoints, and lifecycle state.
Axis records should:

- use stable T3 IDs rather than infer identity from titles, paths, provider session IDs, or array
  position;
- handle deletion and archival as observable lifecycle changes instead of silently forking a copy;
- record the T3 event sequence or equivalent cursor used to derive their state when consistency
  matters;
- contain only Axis-owned fields, not cached replicas of the complete Thread; and
- degrade safely when an environment is offline or an older T3 server cannot provide a newer field.

If Axis metadata must cross the wire, its schema belongs in the existing contracts package and must
follow T3's replay and client/server compatibility rules.

### Shared Memory

Shared Memory is a derived Axis capability, not a second conversation recorder. It should consume
the existing Thread/Turn/message/activity/event stream and provider outputs, then store only the
curated facts, summaries, embeddings, provenance, and processing cursors that are specific to
memory retrieval.

Every memory item should retain provenance back to its environment, Thread, Turn or message/event,
source context, and source sequence where available. Reprocessing must be idempotent. Deletion,
permission, and retention policy must be able to invalidate derived memory without altering T3
history. Memory retrieval is context-scoped: using the same personal provider in two Companies does
not join their memories. Memory must not monitor provider subprocesses, scrape provider session
files, or maintain parallel Turn and Thread timelines.

### Work Hub

Work Hub should be a projection over existing Projects, Threads, Turns, activities, approvals,
proposed plans, checkpoints, and settlement/archive state. Its server-side logic may combine those
records with Axis metadata, but it must not become another command log or agent runtime.

Actions originating in Work Hub dispatch existing T3 commands or narrowly added contract commands.
Completion is observed through persisted events, projections, and receipts—not guessed from client
timers or provider process output. The UI should consume shared client-runtime state where that state
already exists, adding Axis-specific selectors or projections only for genuinely new behavior.

Its four primary views are Overview, Calendar, Messages, and Work Board. Company and Personal data
is collected through MCPs available to provider bindings in each context, normalized into
context-owned Axis projections, and combined only in the user's Work Hub view. See
[Work Hub](./WORK_HUB.md) for the source and isolation model.

### Chat and Cowork

Chat and Cowork are product experiences, not separate conversation models. Both use the same T3
Project, Thread, Turn, provider instance, approval, activity, and checkpoint lifecycle.

Chat is the conversation-focused presentation of a Thread. Cowork is a task-focused presentation
that can add Axis organization, status, and derived work context around that same Thread. A user may
move between those presentations without converting or copying the underlying conversation. Future
multi-agent coordination remains above the individual T3 Threads; it does not introduce an
`AxisChat`, `AxisCoworkSession`, or another turn engine.

### Remote and mobile

Axis remote and mobile experiences use T3's authenticated RPC and environment connection runtime.
Execution, credentials, filesystem paths, and provider state stay on the server that owns the
Project. Axis does not add a product-specific WebSocket, filesystem proxy, sync database, or tunnel.

New remotely visible behavior starts with a typed contract, server authorization, and an
environment-scoped implementation. Shared connection/domain behavior belongs in
`packages/client-runtime`; web and mobile supply platform services and UI. Desktop-specific code is
reserved for capabilities that truly require Electron or host IPC.

## Placement of Axis-specific code

Create a namespace only when the first concrete feature needs it. Do not add empty directories or a
package that only re-exports T3.

Use these defaults when implementation begins:

- server-only Axis behavior: `apps/server/src/axis/<capability>/`;
- web UI: `apps/web/src/features/axis/<capability>/`;
- mobile UI: `apps/mobile/src/features/axis/<capability>/`;
- desktop host/IPC behavior, only when required: the narrow existing desktop subsystem first, or
  `apps/desktop/src/axis/<capability>/` when the behavior is exclusively Axis-owned;
- wire schemas: a clearly named Axis domain module inside `packages/contracts/src`, exported through
  the existing package boundary;
- shared web/mobile behavior: a narrow Axis subpath in `packages/client-runtime`, following its
  no-root-export convention; and
- a new `packages/axis-*` package only when code has at least two real consumers and a stable
  dependency boundary that cannot live in contracts or client-runtime.

The name of a directory is not sufficient isolation. Axis code must depend on T3's public contracts
and services, avoid deep UI-to-persistence coupling, and keep environment scoping explicit.

## When T3 core may change

Prefer, in order:

1. Compose an existing contract, service, command, projection, or client-runtime primitive.
2. Add Axis-owned metadata or a derived projection in an Axis namespace.
3. Add a narrow extension point to T3 core.
4. Change core behavior only when the existing invariant is incorrect for T3 itself.

A T3 core change is justified only when all of these are true:

- the requirement cannot be implemented safely at an existing boundary;
- the change preserves event replay, RPC compatibility, environment ownership, provider isolation,
  and all applicable clients/providers;
- it is the smallest generic primitive, with no Axis product policy embedded in it;
- it has focused tests for the changed behavior; and
- it is reasonable to propose upstream independently, or the divergence and merge cost are
  explicitly accepted in the change description.

Branding, convenience, anticipated reuse, and avoiding a small Axis adapter are not sufficient
reasons to modify core.

## Review checklist

For each Axis change, reviewers should be able to answer:

- Which side of the ownership table owns the new state and lifecycle?
- What is the canonical identity and is it environment-scoped where required?
- Is existing T3 state referenced/projected, or copied into a competing source of truth?
- Does provider-specific behavior remain at the driver/adapter boundary?
- Does remote behavior use contracts, authorization, RPC, and client-runtime?
- Which web, desktop, mobile, provider, reverse-state, and connection-mode cases apply?
- How many upstream-owned lines are changed, and why is each change necessary?

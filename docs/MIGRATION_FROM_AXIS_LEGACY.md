# Migration from Legacy Axis

## Principle

Legacy Axis is a source of product requirements and proven workflows, not the architectural base of Axis Next.

The migration goal is to preserve differentiated capabilities while discarding infrastructure that T3 Code already implements. Do not copy directories wholesale and do not reproduce the old UI merely because it exists.

Every legacy component must be classified before code is ported.

## Classification model

### `KEEP`

The capability, behavior, algorithm, content, or design can survive essentially unchanged. It may still move into a new Axis namespace.

Use sparingly for code because framework/runtime assumptions may have changed.

### `PORT`

The capability belongs to Axis, but its implementation should be rebuilt against T3 extension points rather than copied mechanically.

This will be the common classification for product-domain features.

### `MERGE`

Legacy Axis contains valuable behavior, but T3 already owns part of the problem. Keep only the Axis-specific behavior and integrate it with T3's existing model.

### `REPLACE_WITH_T3`

T3 already provides the infrastructure. The legacy Axis implementation should not return.

### `DELETE`

The capability is obsolete, redundant, accidental complexity, or no longer aligned with the product.

## Mandatory inventory format

Before migrating a legacy area, record at least:

| Field | Meaning |
| --- | --- |
| Legacy location | File/module/feature in old Axis |
| Capability | User/product behavior it provides |
| Classification | KEEP / PORT / MERGE / REPLACE_WITH_T3 / DELETE |
| T3 equivalent / extension point | Existing T3 capability to reuse |
| Axis target | New Axis module/domain if any |
| Data migration | Whether persisted data must move |
| Removal criteria | When the legacy implementation can be discarded |

A file is not a migration unit by itself. Classify the capability first; several legacy modules may collapse into one T3-backed Axis feature.

## First-pass classification

This is the architectural default before a file-by-file audit of the old repository.

| Legacy Axis area | Default classification | Axis Next direction |
| --- | --- | --- |
| Terminal/process execution | `REPLACE_WITH_T3` | Use T3 terminal/runtime. |
| Filesystem and file reading/writing | `REPLACE_WITH_T3` | Use T3 filesystem/project contracts. |
| Git operations | `REPLACE_WITH_T3` | Use T3 Git/source-control services. |
| Diff rendering/data plumbing | `REPLACE_WITH_T3` / `MERGE` | Keep only genuinely Axis-specific product UX; use T3 diff data/runtime. |
| Checkpoints | `REPLACE_WITH_T3` | Use T3 checkpoint infrastructure. |
| Worktrees | `REPLACE_WITH_T3` | Use T3 worktree/project lifecycle. |
| Base agent runner/process management | `REPLACE_WITH_T3` | T3 provider runtime owns execution. |
| Claude Code integration | `REPLACE_WITH_T3` | Use T3 Claude provider support. |
| Codex integration | `REPLACE_WITH_T3` | Use T3 Codex provider support. |
| Provider registry/adapters | `REPLACE_WITH_T3` | Use `ProviderInstanceRegistry` and T3 drivers. |
| Multiple accounts/provider runtimes | `MERGE` | Represent each runtime account with T3 provider instances; port only Axis organization/assignment metadata. |
| Base threads/sessions | `REPLACE_WITH_T3` | T3 Thread/session state remains authoritative. |
| Axis Agent Session metadata | `PORT` / `MERGE` | Rebuild as metadata referencing T3 `ThreadId` and provider instance. |
| Permission/approval plumbing | `REPLACE_WITH_T3` | Consume T3 approval lifecycle. |
| Orchestration event/runtime engine | `REPLACE_WITH_T3` | Use T3 orchestration engine/event store. |
| Cross-agent Axis workflows | `MERGE` | Port policy/workflow semantics as a coordinator over T3 orchestration. |
| Remote transport/networking | `REPLACE_WITH_T3` | Use T3 connection/relay/remote infrastructure. |
| Axis remote-control product UX | `PORT` / `MERGE` | Rebuild UX/policy on T3 remote runtime. |
| Companies | `PORT` | Axis-owned domain; redesign around clean new contracts/persistence. |
| Workspaces | `PORT` | Axis-owned organizational domain; bind T3 project/repository roots. |
| Shared Memory | `PORT` | Rebuild provider-independent scoped memory on new Axis domains. |
| Work Hub | `PORT` / `MERGE` | Rebuild product read model using Axis metadata + T3 projections/events. |
| Calendar | `PORT` | Axis-owned product capability. |
| Tasks | `PORT` | Axis-owned product capability, potentially connected to Work Hub/Calendar. |
| Notifications | `MERGE` | Keep Axis policy/UX; drive it from T3 lifecycle + Axis events and platform notification APIs. |
| Legacy app-wide state for execution | `REPLACE_WITH_T3` | Use existing T3 client/runtime projections rather than mirroring runtime state. |
| Legacy design system/components | `KEEP` / `PORT` / `DELETE` case-by-case | Reuse only components that improve Axis; do not force visual parity. |
| Legacy navigation/layout | `PORT` / `DELETE` case-by-case | Recreate only information architecture still required by Axis Next. |
| Compatibility shims for deleted infrastructure | `DELETE` | Do not preserve old abstractions solely to ease a mechanical port. |

## Areas that should probably not be ported

Unless a later audit finds an Axis-specific behavior missing from T3, do **not** port legacy implementations of:

- terminal and PTY lifecycle;
- filesystem abstraction;
- file readers/edit plumbing;
- Git command layer;
- diff/checkpoint/worktree infrastructure;
- provider process runners;
- Claude/Codex adapters;
- generic provider registry;
- base agent/thread/session lifecycle;
- permission plumbing;
- generic orchestration event engine;
- remote/network transport;
- connection/reconnect mechanics;
- desktop/web/mobile shell infrastructure.

These are precisely the areas for which Axis Next adopted T3 as its foundation.

## Migration sequence

### Phase 1 — Establish boundaries

Land Axis architecture/upstream/migration documentation before feature code.

### Phase 2 — Establish Axis identity scopes

Implement Companies and Axis Workspaces. Define repository bindings without replacing T3 project/filesystem identity.

### Phase 3 — Map execution identities

Add provider/account organization around `ProviderInstanceId`, followed by Axis Agent Session metadata around T3 `ThreadId`.

### Phase 4 — Port differentiated product capabilities

Port Shared Memory, Work Hub, Calendar/tasks, cross-agent workflow semantics, notifications, and Axis-specific remote/mobile UX in dependency order.

### Phase 5 — Migrate legacy data

Only after target schemas and behavior are stable:

1. inspect legacy persisted data;
2. map records into Axis-owned target domains;
3. map legacy execution references to surviving T3 identities where possible;
4. write explicit, idempotent migration/import tooling;
5. preserve source backups until validation is complete;
6. remove compatibility code after acceptance.

Do not design new Axis domains around accidental legacy database shapes.

## UI migration policy

The legacy UI is evidence of workflows, not a visual specification.

For each screen ask:

1. What task did the user perform?
2. Which information was essential?
3. Which parts now come for free from T3?
4. What Axis-specific workflow remains?
5. Can the new experience use native T3 patterns rather than introducing a parallel shell?

A screen may be deleted even if its capability survives elsewhere.

## Data ownership during migration

Do not copy T3-owned runtime state into new Axis tables just to preserve legacy schemas.

Examples:

- store `ThreadId`, not a shadow copy of thread status/messages;
- store `ProviderInstanceId`, not a duplicate provider runtime configuration unless Axis owns a distinct metadata field;
- store repository/root bindings, not a second filesystem catalog;
- derive Work Hub execution state from T3 projections/lifecycle instead of maintaining a second state machine.

## Migration acceptance criteria

A migrated capability is complete when:

- its Axis-owned behavior exists on the T3 foundation;
- no parallel runtime abstraction remains without a documented reason;
- persisted Axis data has a clear owner and scope;
- desktop/web/mobile implications have been reviewed;
- upstream-owned code changes are minimal and justified;
- legacy compatibility code has an explicit deletion path;
- the old implementation can be removed without losing differentiated product behavior.

## Decision rule

When uncertain between porting legacy infrastructure and adapting T3, default to adapting T3 through an Axis-owned layer.

The burden of proof is on introducing a second implementation of something T3 already owns.

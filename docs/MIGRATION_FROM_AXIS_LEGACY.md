# Migration from Legacy Axis

The legacy Axis is a source of product requirements and proven workflows, not the implementation
baseline for Axis Next.

Axis Next starts from T3 Code specifically so that workstation and agent-harness infrastructure no
longer has to be maintained twice. Migration therefore happens capability by capability, after
classifying each legacy component.

## Classification

Every legacy Axis component, service, schema, screen, or workflow must be classified before porting.

### KEEP

Keep the capability and substantially keep the implementation only when it is Axis-specific,
well-factored, compatible with the T3 architecture, and cheaper to preserve than to adapt.

This should be uncommon for infrastructure and more common for isolated product/domain logic.

### PORT

Port the capability into an Axis namespace when the concept still belongs to Axis but the old code
cannot be reused directly because the surrounding runtime, contracts, persistence, or UI shell has
changed.

### MERGE

Merge the useful Axis behavior into an existing T3 primitive when both systems model overlapping
concepts. The resulting source of truth must be T3 for T3-owned runtime behavior, with Axis keeping
only its additional metadata/policy/UX.

### REPLACE_WITH_T3

Delete the legacy implementation and use the T3 equivalent. This is the default for
non-differentiating workstation/agent-harness infrastructure.

### DELETE

Remove the component when neither the implementation nor the capability belongs in Axis Next.
Examples include obsolete glue, duplicate state, migration-only code with no remaining consumer,
and UX built solely around constraints that T3 no longer has.

## Default classification by capability

The following is the starting hypothesis. Actual legacy files should be classified individually
when migration work reaches them.

| Legacy capability | Default | Axis Next direction |
| --- | --- | --- |
| Terminal runtime/UI plumbing | REPLACE_WITH_T3 | Use T3 terminal contracts/runtime/UI primitives. |
| Filesystem browsing/reading/writing | REPLACE_WITH_T3 | Use T3 project/filesystem services and RPC. |
| Git commands/status | REPLACE_WITH_T3 | Use T3 VCS/Git services. |
| Diff generation/review plumbing | REPLACE_WITH_T3 | Use T3 diff/review/checkpoint infrastructure. |
| Checkpoints/revert/worktrees | REPLACE_WITH_T3 | Use T3 hidden-ref checkpointing and worktree mechanics. |
| Claude execution wrapper | REPLACE_WITH_T3 | Use T3 Claude driver/adapter/provider instance. |
| Codex execution wrapper | REPLACE_WITH_T3 | Use T3 Codex driver/adapter/provider instance. |
| Other provider wrappers | REPLACE_WITH_T3 | Prefer T3 providers; add a T3 driver only for genuinely unsupported providers. |
| Provider login/auth plumbing | REPLACE_WITH_T3 | Keep provider lifecycle behind T3 provider instances/drivers. |
| Base provider session state | REPLACE_WITH_T3 | T3 owns provider sessions and runtime bindings. |
| Base conversation/thread model | REPLACE_WITH_T3 | T3 thread/turn model is authoritative. |
| Permission/approval plumbing | REPLACE_WITH_T3 | Consume normalized T3 approvals/user-input state. |
| WebSocket/connection manager | REPLACE_WITH_T3 | Use T3 contracts and client-runtime connection owner. |
| Remote transport | REPLACE_WITH_T3 | Use T3 direct/Tailscale/SSH/Connect model. |
| Generic desktop shell | REPLACE_WITH_T3 | Keep Electron shell upstream-compatible. |
| Generic mobile connection shell | REPLACE_WITH_T3 | Keep T3 mobile connection/runtime architecture. |
| Generic event log / execution projector | REPLACE_WITH_T3 | Reuse T3 orchestration event log/projections/reactors. |
| Companies | PORT | Reimplement as Axis domain on top of stable T3 references. |
| Workspaces | PORT | Reimplement as Axis organization; do not reuse T3 `project` as a synonym. |
| Provider/account organization metadata | MERGE | Map Axis metadata/policy onto T3 provider instances. |
| Axis Agent Sessions | MERGE | Keep Axis metadata while referencing T3 threads/sessions. |
| Shared Memory | PORT | Preserve product semantics; integrate through T3 project/thread/provider seams. |
| Work Hub | PORT | Rebuild around Axis workspace/session/task references and T3 execution state. |
| Calendar | PORT | Preserve domain/workflows; rebuild UI/runtime integration as needed. |
| Cross-agent orchestration | MERGE | Keep Axis workflow semantics; execute through T3 orchestration/providers. |
| Notifications | MERGE | Keep Axis notification UX/rules; derive execution status from T3 durable state. |
| Axis remote-control UX | MERGE | Build product UX on T3 remote/connection runtime. |
| Legacy visual shell/design copies | DELETE or PORT selectively | Recreate only product-specific UX; do not port layouts by obligation. |
| Legacy infrastructure adapters/glue | DELETE | Remove when T3 makes them unnecessary. |

## Migration principles

### 1. Migrate data semantics before code

For each feature, identify the durable information users actually need to preserve. Do not start by
copying repositories, components, hooks, or tables.

Example: for an old Axis agent session, the durable value may be company/workspace association,
task association, labels, timestamps, and memory scope. The provider process/session implementation
is not migration data because T3 now owns it.

### 2. Establish the new source of truth first

Do not import legacy records until the Axis Next model that will own them is stable enough to
validate the mapping.

The legacy importer must target new Axis/T3 identifiers explicitly. Avoid compatibility layers that
make old IDs silently behave like T3 thread/project/provider IDs.

### 3. Use stable cross-environment references

When legacy data points to repositories, sessions, or accounts, migration must resolve them to
explicit T3 environment/project/thread/provider-instance references. Do not assume a path, provider
name, or display label is globally unique.

### 4. Do not import runtime state T3 can rebuild

Avoid migrating caches, process IDs, terminal sessions, websocket state, transient approvals,
derived Git state, provider health probes, model catalogs, or other runtime caches.

### 5. Do not preserve schema compatibility with legacy Axis internally

Compatibility belongs in a bounded importer, not throughout the new domain. Once data is imported,
Axis Next code should operate only on the new model.

### 6. Visual parity is not a requirement

A legacy screen should be decomposed into its jobs and data requirements. Reuse T3 UI and
interaction patterns when they solve those jobs better. Port a custom UI only where the Axis
product concept actually needs one.

## Feature-by-feature migration checklist

Before porting a legacy feature, answer:

1. What user capability must survive?
2. What data must survive?
3. Is the capability T3-owned or Axis-owned under `docs/AXIS.md`?
4. Which classification applies: KEEP, PORT, MERGE, REPLACE_WITH_T3, or DELETE?
5. Which T3 primitive already satisfies part or all of it?
6. What is the new source of truth?
7. Is the data environment-owned or Axis-global?
8. What stable T3 references are required?
9. Which web/desktop/mobile surfaces need the capability?
10. What legacy code can be deleted instead of adapted?
11. Can the migration be performed once through an importer instead of carrying a compatibility
    layer indefinitely?
12. What proves the legacy data was mapped correctly?

## Legacy migration sequencing

Do not start bulk legacy migration until the destination domains exist.

Recommended order:

1. establish fork architecture/boundaries;
2. establish Company/Workspace identity and global ownership;
3. establish provider-instance mappings;
4. establish Axis Agent Session metadata;
5. establish Shared Memory scopes/storage;
6. establish Work Hub/Calendar domain records;
7. establish Axis orchestration/notification state;
8. inventory legacy data against those destination models;
9. implement bounded importers;
10. verify migration on a copied legacy dataset;
11. delete migration-only compatibility code once the supported migration path is complete.

## What should not be ported first

The highest-risk mistake is beginning with the parts that were expensive in the legacy Axis but are
already T3's strengths. Do **not** begin migration with:

- terminal;
- file tree/file reader;
- filesystem watchers;
- Git/diff/checkpoint/worktree layers;
- provider process management;
- Claude/Codex adapters;
- base thread/session runtime;
- permission plumbing;
- websocket/remote transport;
- desktop shell;
- generic mobile connectivity;
- duplicate execution/event-log infrastructure.

Starting there would recreate the maintenance problem that motivated Axis Next.

## Migration deliverable format

When a legacy area is analyzed, record the decision in the implementing PR rather than maintaining
a second permanent file-by-file catalog in this document. The PR should state the classification,
new source of truth, data mapping, and deleted/replaced legacy implementation.

This document defines the policy; merged PRs are the implementation record.

# T3 Upstream Policy

## Upstream

Axis Next is a long-lived fork of:

- upstream repository: `pingdotgg/t3code`;
- Axis repository: `gustavolbs/axis-next`;
- upstream development branch: `main`.

The Axis fork baseline used for the initial architecture work is:

```text
0dd5c64bcfac7974d81bac76740ecd83540077e8
fix(server): detect nested Git workspaces for checkpoints (#9842)
```

At the time of the initial architecture analysis on 2026-09-04, this commit was a direct ancestor of upstream `main`, which had already advanced by three commits. This is expected: upstream is active and Axis must be designed for continuous synchronization rather than a one-time fork.

## Objective

Upstream updates should remain routine. The fork should spend its divergence budget on Axis product capabilities, not on renamed internals or duplicated T3 infrastructure.

The ideal shape is:

```text
T3 upstream commits
        │
        ▼
Axis main
        │
        ├── additive Axis packages/modules
        ├── thin composition hooks
        └── minimal product-surface integration
```

## Rules

1. Do not rename existing T3 packages, storage paths, environment variables, internal service tags, or imports solely for branding.
2. Prefer new Axis files/directories over modifications to upstream-owned files.
3. Never mix an upstream synchronization with unrelated Axis feature work in the same PR.
4. Keep upstream commits identifiable; do not rewrite upstream history to make it look Axis-authored.
5. When a T3 capability already satisfies an infrastructure need, delete/avoid the Axis duplicate rather than maintaining both.
6. Treat shared contracts, connection runtime, provider drivers, orchestration engine, projections, and migration registration as conflict-sensitive areas.
7. Every necessary central T3 modification must document its extension rationale.

## Recommended Git remote setup

A local clone should use conventional remotes:

```bash
git remote -v
# origin   git@github.com:gustavolbs/axis-next.git
# upstream git@github.com:pingdotgg/t3code.git
```

If `upstream` is missing:

```bash
git remote add upstream git@github.com:pingdotgg/t3code.git
git fetch upstream
```

The remote name itself is a local convention; the architectural requirement is that the upstream relationship stays explicit.

## Synchronization workflow

Prefer a dedicated synchronization PR:

```bash
git fetch upstream
git switch main
git pull --ff-only origin main
git switch -c upstream/t3-YYYY-MM-DD
git merge upstream/main
```

Then:

1. resolve conflicts without opportunistic Axis refactors;
2. run the repository-required checks from T3 development documentation;
3. inspect changes in provider/runtime/contracts/persistence/clients that affect Axis extension points;
4. open a PR whose only purpose is syncing T3;
5. merge the sync before rebasing/merging new Axis feature branches as appropriate.

For the shared `main` branch, prefer preserving the upstream relationship rather than rebasing published Axis history repeatedly. Feature branches can be rebased when useful before merge.

## Conflict budget

### Low-conflict zones

Prefer placing Axis code here:

- `docs/AXIS.md`;
- `docs/AXIS_ARCHITECTURE.md`;
- `docs/T3_UPSTREAM.md`;
- `docs/MIGRATION_FROM_AXIS_LEGACY.md`;
- `packages/axis-*`;
- `apps/server/src/axis/**`;
- `apps/web/src/features/axis/**`;
- `apps/mobile/src/features/axis/**`;
- `apps/desktop/src/axis/**` when native Axis integration is required.

### Medium-conflict zones

Changes here are sometimes unavoidable but should stay thin:

- application route/navigation registries;
- server composition roots / Effect layer assembly;
- package manifests and lockfile;
- settings registries;
- native capability registration.

### High-conflict zones

Avoid modifying these unless the feature cannot be expressed externally:

- `packages/contracts` core orchestration/provider/RPC contracts;
- `packages/client-runtime` connection internals;
- provider drivers/adapters and provider process lifecycle;
- `apps/server/src/orchestration/Services/OrchestrationEngine.ts`;
- canonical projection reducers/tables;
- `apps/server/src/persistence/Migrations.ts`;
- remote/relay transport;
- base thread/session state machinery.

## Central-change justification

Any PR that modifies a high-conflict T3-owned area should include a section with:

```md
### T3 core modification

- T3-owned file(s):
- Axis requirement:
- Existing extension points evaluated:
- Why an Axis-side adapter/composition layer is insufficient:
- Smallest change made to T3 core:
- Desktop impact:
- Web impact:
- Mobile impact:
- Upstream conflict risk:
- Tests / evidence:
```

If this section cannot explain why the core edit is necessary, the code should normally be moved back behind an Axis-owned boundary.

## Migration numbering risk

T3 currently registers SQL migrations statically in `apps/server/src/persistence/Migrations.ts` with sequential numeric IDs. Because upstream continues to add migrations, reserving Axis numbers in the same sequence would create a persistent collision surface.

Before Axis's first schema migration:

1. determine whether the Effect migrator can safely maintain a separate Axis migration loader/history in the same database;
2. prefer that isolated Axis migration path if it preserves startup ordering and transactional safety;
3. if isolation is not supported, keep the central manifest integration minimal and explicitly document the conflict strategy.

Do not start a separate Axis database merely to avoid touching the migration manifest unless there is a stronger architectural reason. Axis metadata and T3 runtime state benefit from sharing the authoritative server persistence boundary.

## Upstream review checklist

For each upstream sync, specifically inspect whether T3 changed:

- `ProviderInstanceId` or provider-instance settings/registry semantics;
- orchestration command/event contracts;
- `OrchestrationEngineService` or event-store semantics;
- projection schemas used by Work Hub/notifications;
- project/root/worktree identity;
- permissions/approval lifecycle;
- connection runtime or remote authorization;
- desktop/web/mobile client contracts;
- persistence startup/migration behavior.

These are extension points, not code we intend to own.

## Product branding

Axis may add its own product surfaces, copy, icons, navigation, and user-facing identity. That does not imply an internal rename project.

Changes such as `T3CODE_HOME -> AXIS_HOME`, `.t3 -> .axis`, package-name rewrites, or service-tag rewrites should occur only when a concrete isolation or product requirement makes coexistence impossible. A cosmetic preference is not sufficient.

## Definition of healthy upstreamability

The fork is healthy when:

- most Axis commits add Axis-owned files;
- upstream sync PRs are boring and mechanically reviewable;
- conflicts cluster in a small set of known composition points;
- T3 runtime features can improve independently of Axis product features;
- Axis can delete custom infrastructure when upstream gains an equivalent capability.

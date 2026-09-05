# T3 Upstream Policy

Axis Next is derived from T3 Code and intentionally keeps T3 as its execution infrastructure.
Keeping upstream integration cheap is an architectural requirement, not repository housekeeping.

## Repository relationship

`gustavolbs/axis-next` was created as an independent repository copy rather than a GitHub-native
fork. GitHub therefore does not provide fork-network synchronization for it.

The canonical upstream is:

```text
https://github.com/pingdotgg/t3code.git
```

At the start of the Axis fork architecture work, Axis `main` pointed to T3 commit:

```text
0dd5c64bcfac7974d81bac76740ecd83540077e8
```

Treat the commit above as the initial provenance marker, not as a permanently pinned T3 version.
Axis should continue consuming upstream changes.

## Local remote setup

Each development checkout should configure remotes explicitly:

```sh
git remote -v

git remote add upstream https://github.com/pingdotgg/t3code.git
# If upstream already exists, verify its URL instead of adding another remote.

git fetch upstream
```

Expected roles:

```text
origin    -> gustavolbs/axis-next
upstream  -> pingdotgg/t3code
```

Do not rename T3 packages, `.t3`, `T3CODE_HOME`, internal imports, or other upstream identifiers just
to make the repository appear more Axis-branded. Those renames create permanent merge conflict
surface without product value.

## Sync strategy

`main` is a long-lived Axis branch and will diverge from upstream once Axis commits land. Do not
rewrite shared `main` to imitate a GitHub fork sync.

Use an integration branch for each upstream update:

```sh
git fetch upstream

git switch main
git pull --ff-only origin main

git switch -c chore/sync-t3-YYYY-MM-DD
git merge upstream/main
```

Resolve conflicts on that branch, run focused verification around the affected areas, and merge the
sync through a dedicated PR.

Why merge rather than repeatedly rebasing Axis `main`:

- it preserves the public history of the long-lived fork;
- it makes upstream integration points auditable;
- it avoids force-pushing shared Axis history;
- conflict resolution is isolated from feature work.

Feature branches may still rebase onto the latest Axis `main` before merge when appropriate.

## Upstream sync cadence

Prefer frequent, small upstream syncs over infrequent large ones, especially before Axis work that
touches a T3 integration hotspot.

A sync is particularly valuable before changing:

- contracts/RPC registration;
- server bootstrap or Effect layer composition;
- persistence migrations;
- provider registry/drivers/adapters;
- web/mobile top-level navigation;
- connection runtime;
- desktop main/preload/IPC;
- project/thread/orchestration schemas.

Do not mix unrelated Axis product work into an upstream-sync PR.

## Ownership rule during conflicts

When an upstream merge conflicts with Axis code, resolve according to ownership rather than
whichever side is newer.

### T3-owned behavior

Prefer upstream for:

- agent/provider runtime behavior;
- provider adapters and native protocol handling;
- terminal/filesystem/Git/diff/checkpoint/worktree behavior;
- project/thread/turn base mechanics;
- permission plumbing;
- remote transport and connection runtime;
- shell infrastructure;
- base orchestration engine/event log/projector/reactors.

If Axis had modified one of these areas, first attempt to move the Axis requirement back behind an
additive extension seam before preserving the forked implementation.

### Axis-owned behavior

Preserve Axis semantics for:

- Companies and Workspaces;
- Axis organization of provider instances/accounts;
- Work Hub and Calendar;
- Shared Memory;
- Axis Agent Session metadata;
- cross-agent coordination above T3 orchestration;
- notifications and Axis-specific product UX.

Preserving Axis semantics does not require preserving an old implementation. If upstream adds a
better primitive, migrate Axis onto it.

## Conflict budget

Every Axis PR should minimize changes to upstream-owned files. Think of edits to central T3 files as
spending a conflict budget.

Before modifying a T3-owned file, prefer this order:

1. new Axis module/file;
2. existing public/internal service boundary;
3. small registration/composition edit;
4. narrow upstream-core change with explicit justification;
5. broad fork of an upstream subsystem — avoid unless there is no viable alternative.

A PR that changes a central T3 implementation should explain:

- why an additive Axis module was insufficient;
- whether the change could reasonably be contributed upstream;
- which surfaces/providers/connection modes are affected;
- what future upstream conflicts are expected.

## Hotspots

These paths are expected to receive frequent upstream changes and should remain as close to T3 as
possible:

```text
AGENTS.md
CLAUDE.md
README.md
package.json
pnpm-workspace.yaml
vite.config.ts

apps/server/src/bootstrap.ts
apps/server/src/orchestration/**
apps/server/src/provider/**
apps/server/src/persistence/Migrations.ts

packages/contracts/src/rpc.ts
packages/contracts/src/orchestration.ts
packages/contracts/src/provider*.ts
packages/client-runtime/src/connection/**
packages/client-runtime/src/environment/**
packages/client-runtime/src/state/**

apps/web/src/AppRoot.tsx
apps/mobile/src/App.tsx
apps/mobile/src/Stack.tsx
apps/desktop/src/main.ts
apps/desktop/src/preload.ts
```

This list is not a prohibition. It is a reminder that integration edits there should stay small.

## Prefer Axis namespaces

Where the architecture permits it, new functionality should live in additive paths such as:

```text
apps/server/src/axis/**
packages/contracts/src/axis/**
packages/client-runtime/src/axis/**
apps/web/src/axis/**
apps/mobile/src/axis/**
apps/desktop/src/axis/**
```

A new Axis directory is not automatically a new subsystem. It should consume the existing T3
service/contract/runtime beneath it.

## Upstream replacement rule

When T3 later adds functionality that overlaps an Axis customization:

1. compare semantics, not names or UI;
2. prefer the T3 implementation when it satisfies the requirement;
3. migrate Axis metadata/presentation onto the upstream primitive;
4. delete the Axis duplicate;
5. keep only the thin Axis-specific behavior that upstream intentionally does not own.

The objective is to make the Axis-specific diff smaller over time whenever upstream absorbs a
non-differentiating capability.

## Branding

Axis product branding may change user-facing application surfaces where required. Internal T3 names
should remain untouched unless they leak into a user-facing Axis requirement or create a technical
constraint.

In particular, branding alone is not sufficient reason to rename:

- package scopes;
- environment variables;
- filesystem data roots;
- protocol fields;
- provider driver names;
- source folders or internal imports.

## Verification for upstream sync PRs

Follow the T3 repository's own development guidance:

- run targeted tests for conflicted/affected behavior;
- run targeted lint/typecheck for changed packages;
- consider web, desktop, mobile, local, and remote behavior where relevant;
- do not replace focused verification with broad speculative refactoring.

For persisted schemas/events, explicitly verify backward compatibility because old environment
history must remain decodable after an upstream update.

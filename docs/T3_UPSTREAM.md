# T3 Upstream Strategy

Axis Next is a product fork of T3 Code, not a rewrite. Maintaining a low-cost path to upstream updates is an architectural requirement.

Upstream project: `pingdotgg/t3code`.

## Principle

Treat T3 as the maintained agent-harness platform and Axis as an additive product layer.

A successful Axis feature should usually produce many lines in Axis-owned files and very few lines in upstream-owned files.

## What remains upstream-owned

The following areas should track T3 closely unless a concrete Axis requirement proves otherwise:

- provider drivers/adapters and provider process lifecycle;
- orchestration command/event engine;
- base project/thread/turn/session mechanics;
- terminal, process, filesystem, Git, diff, checkpoint, and worktree infrastructure;
- permission plumbing and provider-native approvals;
- connection runtime and reconnect behavior;
- remote/relay/SSH/Tailscale infrastructure;
- desktop/web/mobile base shells;
- core RPC transport;
- updater/release plumbing;
- `.t3`, `T3CODE_HOME`, package scopes, package names, and internal protocol terminology.

Do not rename these merely to make the fork look like Axis.

## What may diverge intentionally

Axis-owned product domains may evolve independently:

- Companies and Workspaces;
- Provider Accounts, credentials, and authentication methods;
- Axis Agent Session metadata;
- Shared Memory;
- Work Hub and Calendar;
- cross-agent workflow policy;
- notifications;
- Axis-specific navigation and remote-control experience.

Intentional divergence belongs in dedicated Axis modules, not copied upstream files.

## Git setup

A local checkout should keep the fork as `origin` and canonical T3 as `upstream`:

```sh
git remote -v
git remote add upstream https://github.com/pingdotgg/t3code.git
git fetch upstream
```

If `upstream` already exists, verify rather than replacing it.

The default Axis branch should periodically integrate the current upstream default branch after upstream CI/release state is understood. Prefer frequent small syncs over rare large merges.

The repository's current upstream workflow may dictate merge versus rebase for a particular maintenance operation. The important invariant is that Axis-only feature commits remain easy to identify and the resulting history does not hide upstream provenance.

## Fork-development rules

### 1. Axis namespaces first

Before editing an upstream file, ask whether the behavior can live in one of:

- `apps/server/src/axis/`;
- `apps/web/src/axis/`;
- `apps/mobile/src/axis/`;
- `apps/desktop/src/axis/`;
- an Axis-owned package.

If yes, put it there.

### 2. Thin integration touchpoints

Some central registries are unavoidable. Examples include:

- RPC method registration;
- server layer/service composition;
- package export/workspace registration;
- SQLite migration manifest registration;
- top-level navigation entries.

Keep those edits mechanical. The central file should import/register Axis behavior, not implement it.

### 3. Do not fork data models gratuitously

Do not create Axis versions of T3 Project, Thread, Turn, Provider Session, Provider Instance, permission request, checkpoint, or environment connection.

Axis metadata references stable T3 IDs and adds product semantics in separate records.

### 4. Do not duplicate adapters

If the underlying Claude Code/Codex/OpenCode runtime can already express a configuration, route Axis accounts into the existing T3 provider-instance/adapter path.

A new adapter is appropriate only for a genuinely different runtime/protocol, not merely a different account or API key.

### 5. Preserve persisted compatibility

Changes to T3 orchestration event schemas have a larger blast radius than ordinary TypeScript changes because old event logs replay at startup. Prefer Axis-owned tables/events when atomicity with T3 execution is not required.

When a T3 persisted event must change:

- make old values decodable;
- test replay/migration behavior;
- evaluate downgrade implications;
- explain why a side table or reactor could not satisfy the requirement.

### 6. Preserve multi-surface contracts

An RPC or shared-runtime change must be evaluated against independently versioned web, desktop, mobile, and remote environments. New Axis clients must tolerate servers that do not advertise an Axis capability, and vice versa where supported.

### 7. Keep secrets out of merge hotspots

Provider-account secrets are not a reason to add plaintext credential fields to T3 settings or generic contracts. Axis should reference secure secret material and materialize only the runtime configuration needed inside the trusted environment.

## Conflict-risk map

### High risk

These files or areas are naturally hot upstream and should contain minimal Axis logic:

- `packages/contracts/src/rpc.ts`;
- `packages/contracts/src/orchestration.ts`;
- `apps/server/src/orchestration/decider.ts`;
- `apps/server/src/orchestration/projector.ts`;
- `apps/server/src/orchestration/Layers/*`;
- `apps/server/src/ws.ts`;
- server startup/composition files;
- provider registry/provider settings code;
- `apps/server/src/persistence/Migrations.ts`;
- web/mobile app roots and global navigation;
- shared connection-runtime registry/supervisor internals.

### Medium risk

- package root exports;
- settings UI;
- provider picker/model picker integration;
- desktop IPC bootstrap;
- project/thread shell components.

### Low risk

Axis-owned namespaces, tables, repositories, components, tests, and contracts that upstream does not contain.

The goal is to move implementation mass into the low-risk category.

## Upstream-sync procedure

For each upstream sync:

1. Fetch canonical T3.
2. Review upstream changes in the high-risk integration areas before resolving conflicts.
3. Integrate upstream without opportunistically refactoring Axis code.
4. Resolve conflicts by re-applying the smallest Axis integration hook, not by preserving an obsolete copied T3 implementation.
5. Run focused tests for every touched conflict area plus Axis tests that depend on it.
6. Re-evaluate any Axis workaround whose underlying T3 limitation was removed upstream.
7. Update architecture documentation only if a durable boundary or strategy changed.

## Upstream-friendly changes

When Axis exposes a missing generic extension point or fixes a bug that is not Axis-specific, prefer an upstreamable implementation.

Examples:

- a provider adapter accepting a runtime-supported non-secret config it previously ignored;
- a generic hook/service registration point;
- a bug in multi-instance provider isolation;
- a cross-surface capability advertisement needed by any fork.

Keep Axis product terminology out of such changes so they can be proposed to T3 independently.

## Core-modification justification

Any Axis PR that changes central T3 behavior should answer in its description:

1. Which T3-owned file/primitive is being changed?
2. What Axis invariant cannot be achieved through existing services, adapters, events, or composition?
3. Why is the change the smallest viable extension?
4. What are the desktop/web/mobile and remote compatibility effects?
5. What is the persisted-data/replay effect?
6. Could this change be upstreamed generically?

If those questions do not have convincing answers, move the implementation back into the Axis layer.

## Naming policy

Do not perform repository-wide replacements from `T3` to `Axis`.

Preserve upstream names when they identify upstream-owned concepts. Use `Axis` naming for Axis-owned concepts and product surfaces.

Examples:

- keep `ProviderInstanceId`, `T3CODE_HOME`, `.t3`, and T3 package scopes where they are existing runtime contracts;
- introduce `AxisCompanyId`, `AxisWorkspaceId`, `ProviderAccountId`, or similarly explicit domain names where new types are required;
- do not alias a T3 Thread as an Axis Agent Session merely for branding.

## Fork health metrics

Periodically review:

- count of modified upstream-owned files;
- size of diffs in high-risk files;
- number of Axis branches inside T3 deciders/adapters/runtime internals;
- upstream sync conflict frequency;
- duplicated T3 infrastructure in Axis namespaces;
- Axis workarounds that upstream has made obsolete.

The desired trend is that Axis product capability grows faster than the number of upstream conflict points.
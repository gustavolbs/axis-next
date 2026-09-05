# Axis Next

Axis Next is the Axis product layer built on top of T3 Code.

The fork exists because T3 Code already solves the agent-harness infrastructure that Axis should not rebuild: provider execution, terminal and filesystem access, Git and checkpoints, thread mechanics, permissions, remote connectivity, and the desktop/web/mobile shells. Axis should spend its complexity budget on the product domains that differentiate it.

This document is the high-level contract for the fork. The detailed design lives in [AXIS_ARCHITECTURE.md](./AXIS_ARCHITECTURE.md), upstream maintenance rules live in [T3_UPSTREAM.md](./T3_UPSTREAM.md), and the legacy migration policy lives in [MIGRATION_FROM_AXIS_LEGACY.md](./MIGRATION_FROM_AXIS_LEGACY.md).

## Product goal

Axis is one control surface for multiple companies, repositories, AI accounts, and agent runtimes.

A representative hierarchy is:

```text
Axis
├── Company: Live Nation
│   └── Workspace: frontend
│       ├── Repo / T3 Project A
│       ├── Claude Personal
│       ├── Claude Work
│       └── Codex Work
└── Company: Company B
    └── Workspace: product
        ├── Repo / T3 Project B
        ├── Claude Company B
        └── Codex Personal
```

The hierarchy is a product and isolation model. It does not replace T3's environment, project, thread, provider-instance, or session primitives.

## Ownership boundary

### T3 owns

- agent execution and provider runtime;
- provider drivers and adapters;
- Claude Code, Codex, Cursor, Grok, OpenCode, Antigravity, and other supported harnesses;
- terminal and process execution;
- filesystem and project file access;
- Git, diffs, checkpoints, and worktrees;
- remote transport, pairing, relay, SSH, and connection infrastructure;
- desktop, web, and mobile base shells;
- permission plumbing and provider-native approvals;
- environment identity;
- base project, thread, turn, and provider-session mechanics;
- the orchestration event log, command engine, projections, and provider reactors.

### Axis owns

- Companies;
- Workspaces;
- Provider Accounts and credential organization;
- Authentication Configuration as a first-class product concept;
- mapping Axis accounts to T3 provider instances/runtime configuration;
- Axis Agent Session metadata and product-level provenance;
- Shared Memory across providers and agents;
- Work Hub and its normalized external-work data;
- Calendar;
- cross-agent orchestration policy and workflows built on T3 execution primitives;
- notifications;
- Axis-specific remote-control/mobile experience;
- Axis-specific product navigation, aggregation, and isolation semantics.

## Non-goals

Axis does not fork T3 merely to rename it. In particular, do not rename package scopes, `.t3`, `T3CODE_HOME`, internal T3 terminology, provider drivers, or protocol concepts without a concrete product requirement.

Axis also does not create a second implementation of threads, agent sessions, permissions, filesystem operations, Git operations, terminal execution, provider adapters, checkpoints, or remote transport when T3 already models the capability.

## Terminology

The following distinctions are architectural, not cosmetic.

### T3 Environment

One running T3 server and the machine, provider credentials/runtime state, filesystem, and durable execution state that it owns. Remote clients control the environment; they do not replace its execution authority.

### T3 Project

An environment-local execution workspace rooted at a directory. Axis may associate a T3 Project with a Company and Workspace, but does not redefine the T3 Project primitive.

### Axis Company

A durable product isolation and organization boundary. Company identity must not be inferred from a filesystem path, provider label, CLI home directory, or environment display name.

### Axis Workspace

A logical grouping inside a Company. A Workspace organizes repositories/T3 Projects, account eligibility, work data, and product context. It is not a synonym for a filesystem directory.

### Provider

The model/service family, for example Anthropic, OpenAI, OpenRouter, or another compatible service.

### Provider Account

A named Axis identity or credential that can be selected, scoped, audited, and mapped to runtime configuration. Examples include `Claude Personal`, `Live Nation Claude Enterprise`, `Anthropic API Personal`, and `OpenAI API Work`.

A Provider Account is not a T3 `ProviderInstanceId` and is not a `CLAUDE_CONFIG_DIR` or `CODEX_HOME`.

### Authentication Configuration

How a Provider Account authenticates. Required supported shapes include OAuth, API Key, enterprise/managed authentication, custom environment variables, and custom endpoint/base URL configuration where the selected runtime supports them.

### Runtime / Agent Harness

The executable integration that performs agent work: Claude Code, Codex, OpenCode, and other T3-supported runtimes.

### T3 Provider Instance

The execution/configuration instance T3 routes work through. Axis Provider Accounts may materialize into T3 provider-instance configuration, but the two concepts remain separate.

### Axis Agent Session

Axis-owned metadata and provenance around agent work: Company, Workspace, account identity, orchestration relationships, memory provenance, notification state, and other product metadata. It augments T3 thread/provider-session mechanics; it does not replace them.

## Provider accounts and credentials are mandatory

API-key and multi-account support is a core Axis requirement, not a future optional feature.

The preferred dependency direction is:

```text
Axis ProviderAccount
  -> AuthenticationConfiguration
  -> RuntimeConfiguration
  -> T3 ProviderInstance configuration
  -> T3 provider adapter / CLI
  -> agent runtime
```

When a T3 runtime already supports custom environment or endpoint configuration, Axis should use that capability instead of building a parallel agent runtime. For example, an Anthropic API account may ultimately resolve to a Claude provider instance with the appropriate environment, while an OpenAI-compatible gateway may resolve to an existing compatible driver configuration.

Secrets must not be stored as plaintext Axis domain data, included in normal logs, or returned to web/mobile clients. Axis records should store opaque secret references and status metadata. The exact secure-storage integration is a required design gate for the Provider Accounts PR.

## Extension rules

1. Add Axis behavior in Axis-owned namespaces before changing T3 core files.
2. Prefer composition over modification: consume T3 services, contracts, events, provider instances, and client-runtime connections.
3. Keep unavoidable T3 touchpoints thin and mechanical.
4. Never introduce an Axis abstraction that competes with an adequate T3 primitive.
5. If T3 core must change, document why an external extension could not satisfy the invariant.
6. Changes to wire contracts must account for desktop, web, mobile, remote clients, and independently versioned servers.
7. Changes to persisted orchestration events must remain replay-compatible.
8. Provider-specific complexity stays at the provider/runtime boundary; Axis product domains should depend on normalized identities and capabilities.
9. Secrets are resolved only in trusted server/desktop execution boundaries and are not product-domain payloads.
10. Every legacy Axis capability is classified before code is ported.

## Expected module direction

The exact packages will be introduced only when their first real domain needs them. The intended shape is:

```text
apps/server/src/axis/
  companies/
  workspaces/
  accounts/
  agentSessions/
  memory/
  workHub/
  calendar/
  orchestration/
  notifications/

apps/web/src/axis/
apps/mobile/src/axis/
apps/desktop/src/axis/        # native/shell integration only when required

packages/axis-contracts/      # future Axis-only wire/domain schemas
packages/axis-client-runtime/ # future shared Axis client state/federation
```

These directories are not created speculatively by the architecture PR. A module appears when a feature needs executable code.

## Roadmap

The dependency-oriented roadmap is:

1. **Fork architecture and boundaries** — durable docs, ownership rules, extension strategy, legacy migration policy. No product behavior.
2. **Companies + Workspaces** — stable product IDs and mappings to T3 environment/project records without replacing those records.
3. **Provider Accounts, Credentials, and Authentication Methods** — mandatory multi-account/API-key domain, secure secret references, account-to-provider-instance materialization, authentication status/testing/re-authentication.
4. **Axis Agent Sessions** — immutable or append-only product provenance around T3 threads/provider sessions.
5. **Shared Memory** — provider-neutral, Company/Workspace/Repo-scoped memory derived from T3 activity without storing private chain-of-thought.
6. **Work Hub foundation** — account-scoped sources and normalized records with provenance.
7. **Calendar** — weekly agenda and calendar-specific source/view behavior on the Work Hub foundation.
8. **Cross-agent orchestration** — workflows that coordinate T3-backed sessions rather than replace T3's execution engine.
9. **Notifications** — completion, failure, permission, and decision notifications sourced from durable T3/Axis state. This may move earlier if it can be delivered independently after Agent Sessions.
10. **Remote Control / Mobile UX** — Axis-specific aggregation and controls over the existing T3 connection runtime.
11. **Legacy Axis migration** — import only approved domain data/capabilities after the new models are stable.

### Mandatory preflight for Provider Accounts PR

Before implementing PR 3, re-audit the then-current upstream code for:

- T3 provider-instance model and registry;
- Claude multi-account behavior and `CLAUDE_CONFIG_DIR` isolation;
- Codex multi-account behavior, `CODEX_HOME`, and shadow-home semantics;
- provider-instance environment variables, custom configuration, and base URL support;
- desktop/server secret storage and redaction behavior;
- what is persisted in server settings versus resolved only at runtime;
- API-key compatibility and limitations for each intended runtime/provider pair;
- authentication testing, reauthentication, and sign-out lifecycle;
- a design that injects credentials into existing T3 execution without creating a parallel agent runtime.

The PR must fail closed for unsupported combinations rather than silently selecting another account, provider, runtime, or Company.

## Definition of a healthy fork

The fork is healthy when a future T3 upstream update can be integrated by resolving a small number of intentional boundary conflicts, while most Axis functionality lives in clearly owned modules. A feature that works but permanently forks the execution core is not considered successful.
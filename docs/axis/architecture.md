# Axis architecture and extension model

This document records the architectural boundary between the T3 foundation and Axis-specific product code. It is intentionally based on the current `axis-next` implementation rather than on the previous Axis architecture.

The governing rule is:

> T3 owns infrastructure. Axis owns semantic organization, context boundaries, projections, and Axis-specific product capabilities.

Before introducing an Axis entity, service, runtime, or persistence path, first ask whether T3 already owns the underlying concept and Axis only needs to organize, authorize, enrich, materialize, or project it.

## Current T3 architecture

T3 is environment-owned and server-authoritative. The environment owns provider processes, credentials, project files, terminal processes, Git state, and persistent orchestration state. Web, desktop, and mobile clients control that environment through authenticated RPC instead of reproducing execution locally.

The main layers are:

1. **Contracts** — `packages/contracts` defines wire/domain schemas shared by independently versioned clients and servers.
2. **Server/environment** — `apps/server` owns execution, provider processes, filesystem/Git/terminal access, persistence, authentication, remote endpoints, and orchestration.
3. **Provider boundary** — provider drivers/adapters translate provider-native behavior into normalized T3 orchestration behavior. Driver kind selects the integration; provider instance identifies one configured account/runtime target.
4. **Orchestration** — commands are serialized by the engine, a pure decider produces durable events, projectors derive read models, and reactors perform side effects after intent is committed.
5. **Persistence/read models** — T3 persists the orchestration event log and projections for projects, threads, turns, thread sessions, activities, pending approvals, checkpoints, and related state.
6. **Client runtime** — `packages/client-runtime` holds connection/environment/domain behavior that must remain consistent across clients.
7. **Surfaces** — web is the primary React client; desktop wraps the web experience with Electron/server-host capabilities; mobile is a separate React Native client over the same environment boundary.
8. **Remote** — pairing, authenticated WebSocket/RPC, SSH-hosted environments, direct network access, and T3 Connect are infrastructure capabilities of the foundation.

This architecture means Axis should usually attach metadata, relationships, configuration materialization, new read models, and product workflows to existing T3 identifiers rather than create replacement execution objects.

## Reuse directly

Future Axis work should treat these concepts as references, not things to recreate:

- `ProjectId` and T3 Project records for repositories/workspace roots;
- `ThreadId`, T3 threads, turns, activities, and thread-session projections;
- `ProviderDriverKind`, `ProviderInstanceId`, and `ProviderInstanceConfig`;
- provider adapters and provider-native session lifecycle;
- provider-instance environment variables and the existing sensitive-value handling;
- orchestration commands/events/reactors/projectors as the execution foundation;
- pending-approval and execution-state projections;
- checkpoint/worktree/Git/filesystem/terminal infrastructure;
- RPC/environment/connection runtime and remote transport;
- web, desktop, and mobile shells.

A legacy Axis `AgentSession` is not assumed to survive as an independent runtime. T3 already persists thread-to-provider-instance linkage and provider session status. A new Axis session entity requires behavior that cannot be represented as metadata or workflow state over those objects.

## Real Axis gaps

The current T3 domain does not, by itself, express the complete Axis product model. The gaps credible enough to investigate in later PRs are:

- Personal and Company context organization above T3 resources;
- Workspace organization inside a context, where useful;
- context-to-project, context-to-provider-instance, and related Axis metadata/authorization relationships;
- shared configuration definitions that can be selectively materialized into provider-native skills, MCP, instructions, environment, and config mechanisms;
- scoped cross-provider memory;
- Work Hub aggregation and normalized read models over authorized external and T3 state;
- cross-agent workflow semantics beyond T3's base thread execution;
- Axis notification policy and product-specific remote/mobile presentation.

The existence and exact shape of every listed abstraction must still be proven by the feature PR that introduces it. In particular, a separate `Profile` entity is **not** established by PR #1. Company/Personal already provide semantic context grouping; a reusable Profile abstraction should only be introduced later if concrete shared-configuration or identity requirements remain that those contexts cannot represent cleanly.

## Axis context boundary

Axis needs a product-level context boundary that T3 does not currently model. The first two context kinds are conceptually:

- **Personal** — the user's personal projects, providers, configuration, memory, tools, and external data;
- **Company** — one isolated employment/client context with its own projects, providers, configuration, memory, tools, and external data.

A Workspace may later subdivide either kind of context, but it must not weaken the parent context boundary.

The isolation rule is strict:

- Company A must not learn Company B data merely because both are available to the same Axis user;
- Company B must not learn Company A data;
- Personal must not implicitly learn Company data;
- a project, thread, memory item, external message, calendar event, task, or tool result keeps its source context/provenance;
- cross-context aggregation is permitted only in explicitly user-facing Axis projections such as Work Hub and must not be silently injected into an agent running inside one Company context.

This is a **data and knowledge boundary**, not a replacement for T3 environment authentication or provider permissions. PR #2 should define the minimum persistence/contracts needed to express the relationship without adding `company_id` or equivalent fields indiscriminately to T3 projection rows.

## Provider instances are resources, not contexts

A T3 provider instance remains the account/configuration/routing unit. Axis must not add `AxisProvider`, `AxisProviderAccount`, `AxisAuthenticationMethod`, or `AxisProviderRuntime` around it.

Axis needs to distinguish two separate questions:

1. **Where does this provider instance originate or belong semantically?** For example, Personal, Company A, or Company B.
2. **In which Axis contexts may the user execute work through it?**

Those answers do not have to be identical.

Examples:

- `Claude Enterprise — Company A` can be restricted to Company A;
- `Codex Enterprise — Company B` can be restricted to Company B;
- `Claude Personal` can originate in Personal and be allowed for Company A or Company B;
- `Claude API Key Personal` can be another Claude provider instance and be allowed in selected Companies;
- `Codex Personal` can similarly be reused where a Company does not provide its own account.

Allowing a Personal provider instance inside Company B grants the ability to execute through that T3 provider instance. It does **not** grant Company B access to unrelated Personal projects, threads, memory, messages, files, MCP data, or Company A data.

This distinction lets Axis support the real employment model where one company supplies an enterprise AI subscription while another company relies on the user's personal subscription, without duplicating provider infrastructure.

API-key or router-backed variants should continue to use the provider instance's native T3 configuration/environment mechanisms, including sensitive values and custom endpoints when supported by that provider. Axis may improve organization and UX, but it must not implement a second streaming/tool/permission runtime or secret store.

## Shared skills, MCPs, instructions, and provider configuration

Sharing a provider instance and sharing its effective agent configuration are separate decisions.

A Personal Claude or Codex instance may have personal skills, MCPs, instructions, or preferences. Reusing that instance for Company B must not automatically expose every Personal tool or source to Company B. A future configuration model must compute the **effective configuration for the active Axis context** and make sharing explicit enough to preserve the context boundary.

The preferred model is:

```text
Axis context configuration
        ↓
selection / composition / policy
        ↓
materialization or synchronization
        ↓
provider-native mechanisms
  ├─ Claude config / skills / instructions
  ├─ Codex config / skills / instructions
  ├─ MCP configuration
  └─ provider-instance environment/config
```

Axis does not become an alternative provider configuration runtime. It owns higher-level organization and materialization; the T3/provider adapter and provider-native mechanisms remain responsible for execution.

The exact source scopes, precedence rules, and shareability model belong in the later shared-configuration/Profile work. PR #1 only establishes the invariant that borrowing a provider instance does not imply borrowing all knowledge or tool access associated with its origin context.

## Projects, threads, Chat, and Cowork

T3 Project remains the repository/workspace-root primitive. Axis Company/Personal/Workspace organization should reference T3 Project IDs rather than wrap or replace Project.

T3 Thread, Turn, activity, and provider-session state likewise remain the durable conversation/execution primitives.

For the current product model:

- **Chat** should be treated primarily as Axis UX over T3 Thread/Turn behavior;
- do not introduce an `AxisChatSession` or duplicate chat runtime;
- do not port the legacy `AgentSession` runtime unless later requirements prove a missing T3 primitive;
- **Cowork**, if retained as a product concept, should be a workflow/view that coordinates existing T3 threads, provider instances, tasks, or Axis orchestration state — not a second session/execution engine.

This keeps Chat/Cowork product semantics small until there is concrete behavior that T3 threads and Axis workflow metadata cannot express.

## Work Hub is a user-private cross-context projection

Work Hub is a central Axis experience that aggregates authorized information across Personal and all connected Companies for the user. It is an explicit exception to normal single-context viewing: it may read multiple contexts to build a private user projection, but that aggregate must not become implicit context for an agent operating inside one Company.

The four primary Work Hub surfaces are:

### Overview

A summary of what matters today across Personal and all Companies. It can combine external work data with T3 execution/approval/activity projections where useful.

### Calendar

A calendar experience comparable to Teams, Outlook, or Google Calendar, showing authorized Personal and Company events together while preserving source/context provenance. The desired product UX includes a strong week view, hourly timeline, correct positioning and overlap behavior, scrolling, current-day/time treatment, responsive behavior, and event details without overflow/z-index defects.

### Messages

A focused view of important work communications, such as relevant Slack messages and Jira/project-tool updates, scoped to the Company or Personal source they came from. Axis should rank/project useful information rather than create a parallel messaging system.

### Work Board

A normalized board with the product columns:

- `TO DO`
- `WORKING`
- `BLOCKED`
- `CODE REVIEW`
- `QA`
- `DONE`

The source-of-truth status remains Jira or the corresponding work-management tool used by each Company. Axis maps source states into this product projection; the board is not, by default, a second task lifecycle that must be kept manually in sync.

### Work Hub data sources

The intended source path is the MCP/provider configuration authorized for each Axis context. For example, a Company's provider configuration may expose Jira, Slack, calendar, or another work system through the provider-native/T3-supported MCP mechanisms.

PR #1 deliberately does **not** establish a generic Axis MCP runtime, direct Jira/Slack integration framework, sync daemon, or caching schema. Before implementing Work Hub ingestion, inspect how each supported provider and T3 expose MCP configuration and tool results, then choose the smallest reliable read/projection path.

If later product requirements need durable indexing or caching, every stored item must retain source context and provenance so a cross-company aggregate cannot leak back into Company-scoped agent context.

## Shared Memory and Axis orchestration

Shared Memory is an Axis capability because T3 provider conversations do not by themselves provide cross-provider knowledge continuity. Its scopes may eventually include Personal/global, Company, Workspace, and Project, but its storage and retrieval model must be designed after the context boundary exists.

Memory should prefer consuming T3 events/projections and explicitly authorized external/context state rather than duplicating tracking for activity T3 already records.

Axis-specific orchestration means product workflows such as delegation, handoff, multi-step work, or Task/Work Hub-driven automation. It should coordinate T3 provider instances, threads, commands, events, and approvals. It must not become a second generic agent execution engine.

## Extension strategy

Prefer extension in this order:

1. **Projection/read composition** — derive Axis UX from existing T3 projections/events or authorized source data without changing execution.
2. **Axis-owned metadata/relationships** — persist references to T3 IDs rather than adding Axis fields directly to T3 projection rows.
3. **Materialization/adaptation** — translate Axis shared configuration into the native mechanism a provider already consumes.
4. **Axis workflow services** — coordinate existing T3 commands and provider instances for product workflows.
5. **Core T3 modification** — only when the preceding options cannot represent required behavior.

When a core modification is necessary, the PR must explain the missing extension point and why an Axis-owned layer cannot solve it correctly.

## Expected code placement

Do not create these directories merely to reserve them. When a feature actually needs code, prefer an Axis namespace local to the layer that owns the behavior:

- `apps/server/src/axis/` for Axis server services, projections, materializers, and workflow coordination;
- `packages/contracts/src/axis/` for Axis-specific wire/domain contracts;
- `packages/client-runtime/src/axis/` for cross-client Axis state and behavior;
- `apps/web/src/axis/` for Axis web/product UI;
- an Axis-local area in `apps/mobile` for mobile-specific product UX;
- desktop-specific Axis code only for behavior that truly belongs to Electron/host integration rather than the shared web experience.

A dedicated Axis package is justified only when a real cross-layer dependency boundary makes it cleaner than local namespaces. PR #1 deliberately creates no source package or runtime namespace.

The dependency direction should remain predominantly **Axis → T3 primitives**. Avoid making core T3 orchestration/provider code depend directly on Axis product modules unless a later feature proves that an extension hook is required.

## Persistence guidance

Axis-owned organizational metadata should prefer Axis-owned tables/read models that reference stable T3 IDs. Avoid modifying T3 projection schemas such as projects, threads, or thread sessions merely to attach Axis grouping metadata.

This preserves the T3 projector/event model and reduces merge conflicts. If a future invariant requires atomic consistency with a T3 event transaction, that requirement must be demonstrated before changing the orchestration persistence path.

For Shared Memory and Work Hub, prefer consuming T3 event/projection state over emitting duplicate tracking events for provider activity that T3 already records.

## Remote and mobile

T3 continues to own environment/server ownership, RPC, pairing, remote transport, SSH-hosted environments, T3 Connect, and the base web/desktop/mobile shells.

Axis-specific remote/mobile work should expose Axis concepts — contexts, Work Hub, notifications, approvals, and Axis workflow actions — over those existing transport/runtime boundaries. Do not port the legacy Axis Remote Control infrastructure as a parallel transport stack.

## Upstream conflict policy

New Axis behavior should be isolated under Axis-owned namespaces and additive contracts whenever possible. The highest-risk conflict zones are T3 provider adapters, orchestration decider/projector code, core persistence migrations/projections, shared RPC contracts, and common web/mobile navigation shells.

Touch those areas only when an extension layer cannot express the required behavior. Avoid cosmetic edits, mass renames, T3-to-Axis internal renaming, or formatting churn in upstream files.

See `upstream-policy.md` for the fork synchronization procedure and `feature-audit-template.md` for the required per-feature audit.

## Axis Legacy

The old Axis implementation is a requirements and UX reference, not an architectural source of truth. When legacy code is available, classify each subsystem as `KEEP`, `PORT`, `MERGE`, `REPLACE_WITH_T3`, or `DELETE` before moving code.

Infrastructure that T3 already owns should default toward `REPLACE_WITH_T3` or `DELETE`. Axis-specific product behavior should be evaluated for `PORT` or `MERGE` based on the current T3 extension points.

## Decisions deliberately deferred

PR #1 establishes boundaries, not speculative schemas. Later PRs must still prove:

- the minimum Personal/Company/Workspace persistence model and relationship cardinalities;
- whether a separate `Profile` abstraction is necessary at all, and what it means if introduced;
- how context-to-provider-instance availability is represented and enforced;
- precedence/shareability/materialization rules for skills, MCPs, instructions, and other provider configuration;
- whether any Axis thread metadata is necessary beyond context/project relationships;
- the Shared Memory storage/retrieval model;
- how Work Hub reads MCP-backed external data reliably across providers, and whether durable caching/indexing is required;
- the minimum workflow state needed for Axis-specific orchestration and notifications.

Each of those feature PRs should start by auditing the T3 implementation and identifying the extension point it intends to use.
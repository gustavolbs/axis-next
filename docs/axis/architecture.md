# Axis architecture and extension model

This document records the architectural boundary between the T3 foundation and Axis-specific product code. It is intentionally based on the current `axis-next` implementation rather than on the previous Axis architecture.

## Current T3 architecture

T3 is environment-owned and server-authoritative. The environment owns provider processes, credentials, project files, terminal processes, Git state, and persistent orchestration state. Web, desktop, and mobile clients control that environment through authenticated RPC instead of reproducing execution locally.

The main layers are:

1. **Contracts** — `packages/contracts` defines wire/domain schemas shared by independently versioned clients and servers.
2. **Server/environment** — `apps/server` owns execution, provider processes, filesystem/Git/terminal access, persistence, authentication, remote endpoints, and orchestration.
3. **Provider boundary** — provider drivers/adapters translate provider-native behavior into normalized T3 orchestration behavior. Driver kind selects the implementation; provider instance identifies one configured account/runtime target.
4. **Orchestration** — commands are serialized by the engine, a pure decider produces durable events, projectors derive read models, and reactors perform side effects after intent is committed.
5. **Persistence/read models** — T3 persists the orchestration event log and projections for projects, threads, turns, thread sessions, activities, pending approvals, checkpoints, and related state.
6. **Client runtime** — `packages/client-runtime` holds connection/environment/domain behavior that must remain consistent across clients.
7. **Surfaces** — web is the primary React client; desktop wraps the web experience with Electron/server-host capabilities; mobile is a separate React Native client over the same environment boundary.
8. **Remote** — pairing, authenticated WebSocket/RPC, SSH-hosted environments, direct network access, and T3 Connect are infrastructure capabilities of the foundation.

This architecture means Axis should usually attach metadata, relationships, configuration materialization, new read models, and new product workflows to existing T3 identifiers rather than create replacement execution objects.

## Reuse directly

Future Axis work should treat these concepts as references, not things to recreate:

- `ProjectId` and T3 Project records for repositories/workspace roots;
- `ThreadId`, T3 threads, turns, activities, and thread-session projections;
- `ProviderDriverKind`, `ProviderInstanceId`, and `ProviderInstanceConfig`;
- provider adapters and provider-native session lifecycle;
- provider-instance environment variables and the existing server secret store;
- orchestration commands/events/reactors/projectors as the execution foundation;
- pending-approval and execution-state projections;
- checkpoint/worktree/Git/filesystem/terminal infrastructure;
- RPC/environment/connection runtime and remote transport;
- web, desktop, and mobile shells.

A legacy Axis `AgentSession` is not assumed to survive as an independent runtime. T3 already persists thread-to-provider-instance linkage and provider session status. A new Axis session entity requires behavior that cannot be represented as metadata or workflow state over those objects.

## Real Axis gaps

The current T3 domain does not, by itself, express the complete Axis product model. The gaps that are credible enough to investigate in later PRs are:

- organization above projects for company/work-context navigation;
- semantic grouping above provider instances for a shared identity/context;
- shared configuration definitions that can be materialized into provider-native skills, MCP, instructions, environment, and config mechanisms;
- scoped cross-provider memory;
- Axis-owned tasks/calendar data where no equivalent T3 durable model exists;
- Work Hub projections combining T3 execution/read models with Axis-owned task/calendar state;
- cross-agent workflow semantics beyond T3's base thread execution;
- Axis notification policy and product-specific remote/mobile presentation.

The existence and exact shape of every listed abstraction must still be proven by the feature PR that introduces it.

## Extension strategy

Prefer extension in this order:

1. **Projection/read composition** — derive Axis UX from existing T3 projections/events without changing execution.
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

## Persistence guidance

Axis-owned organizational metadata should prefer Axis-owned tables/read models that reference stable T3 IDs. Avoid modifying T3 projection schemas such as projects, threads, or thread sessions merely to attach Axis grouping metadata.

This preserves the T3 projector/event model and reduces merge conflicts. If a future invariant requires atomic consistency with a T3 event transaction, that requirement must be demonstrated before changing the orchestration persistence path.

For Shared Memory and Work Hub, prefer consuming T3 event/projection state over emitting duplicate tracking events for provider activity that T3 already records.

## Provider configuration guidance

T3 provider instances already carry driver-specific opaque configuration plus environment variables, including sensitive values whose actual contents are kept in the server secret store and redacted from clients.

Shared Axis configuration should therefore be modeled as a higher-level source that materializes/synchronizes into provider-native formats. Examples include Claude config-directory skills, project `.claude/skills`, Codex-native configuration, MCP configuration, and instance environment variables. Axis must not create a second provider runtime or secret-management subsystem to accomplish this.

## Axis Legacy

The old Axis implementation is a requirements and UX reference, not an architectural source of truth. When legacy code is available, classify each subsystem as `KEEP`, `PORT`, `MERGE`, `REPLACE_WITH_T3`, or `DELETE` before moving code.

Infrastructure that T3 already owns should default toward `REPLACE_WITH_T3` or `DELETE`. Axis-specific product behavior should be evaluated for `PORT` or `MERGE` based on the current T3 extension points.
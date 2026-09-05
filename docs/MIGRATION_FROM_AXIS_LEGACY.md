# Migration from Legacy Axis

The previous Axis repository is a source of product requirements, domain lessons, and migration inputs. It is not the implementation template for Axis Next.

Every legacy capability must be classified before code is copied.

## Classification vocabulary

- **KEEP** — the product capability or invariant remains valid with little conceptual change.
- **PORT** — the capability belongs to Axis Next but should be reimplemented against T3 primitives.
- **MERGE** — the legacy concept overlaps a T3 capability; preserve only the Axis-specific semantics and integrate them into the T3 model.
- **REPLACE_WITH_T3** — T3 already owns the capability; do not bring the legacy implementation.
- **DELETE** — obsolete, duplicated, compatibility-only, or debt that should not survive the migration.

Classification applies to capabilities first. Individual files are evaluated only when the relevant migration PR begins.

## Executive classification

| Legacy capability | Classification | Axis Next direction |
| --- | --- | --- |
| Companies / company isolation | PORT | New Axis domain referencing T3 environments/projects/accounts |
| Project-to-company context | MERGE | Keep Axis company semantics; bind to T3 Project instead of replacing it |
| Logical Workspaces | PORT | New Axis grouping; never redefine T3 filesystem project/workspace mechanics |
| Connection/account identity | MERGE | Axis ProviderAccount domain mapped to T3 ProviderInstance routing |
| Claude account profiles | MERGE | Keep account identity; use T3 Claude multi-instance/config support |
| Codex account profiles | MERGE | Keep account identity; use T3 Codex instance/home/shadow-home support |
| API-key credential profiles | PORT | Mandatory Axis credential domain using secure secret references and T3 runtime configuration |
| Custom provider endpoint/router profiles | MERGE | Axis account/auth metadata plus existing T3 instance env/driver configuration where supported |
| Custom AgentRuntime | REPLACE_WITH_T3 | T3 provider adapters + orchestration own execution |
| Standalone job/execution engine | REPLACE_WITH_T3 | Use T3 threads/turns/provider sessions/events |
| Custom filesystem tools | REPLACE_WITH_T3 | Use T3 project/filesystem capabilities |
| Custom process/terminal tools | REPLACE_WITH_T3 | Use T3 terminal/process infrastructure |
| Custom Git/diff/worktree stack | REPLACE_WITH_T3 | Use T3 Git, checkpoint, diff, worktree infrastructure |
| Custom permission runtime | REPLACE_WITH_T3 | Reuse T3 permission plumbing; add only Axis policy metadata if later required |
| Custom desktop agent shell | REPLACE_WITH_T3 | Extend T3 desktop shell rather than porting the old shell |
| Custom remote transport/control infrastructure | REPLACE_WITH_T3 | Reuse T3 environment/remote/relay/SSH/Tailscale stack |
| Legacy conversation/thread storage | REPLACE_WITH_T3 | T3 threads/event log are canonical execution history |
| Project Memory / shared memory concept | PORT | Rebuild as Axis Shared Memory driven by T3 events and Axis provenance |
| Work Hub normalized-data concept | PORT | Reuse normalized/provenance ideas; reimplement collection/storage around new account model |
| Calendar capability | PORT | Rebuild on Work Hub/client architecture; no visual fidelity requirement |
| Cross-agent workflow/orchestration semantics | MERGE | Axis owns workflow policy; T3 owns individual executions and base orchestration |
| Notifications | PORT | Derive from durable T3/Axis execution state |
| Legacy UI styling/layout | DELETE | Reuse selectively; capabilities and UX goals matter, not visual cloning |
| Legacy provider/runtime fallback logic | DELETE | Exact account/runtime selection should fail closed, not silently reroute |
| Legacy compatibility bridges after data migration | DELETE | Temporary only; remove after migration verification |

## What must not be ported

### Agent runtime and tool infrastructure

Legacy Axis invested heavily in its own provider-neutral runtime, tool catalog, filesystem/process/Git execution, permission gate, browser/MCP execution, lifecycle events, and UI runtime timeline.

Those implementations solved real problems, but T3 now supplies the base execution platform. Porting them would recreate the exact duplication this fork is intended to eliminate.

The migration rule is:

> Preserve the product invariant; replace the implementation with the nearest T3 primitive.

Examples:

- “an agent can edit a repo and run tests” becomes normal T3 provider execution and permissions;
- “a run must be tied to an exact account” becomes Axis Agent Session metadata plus a T3 Provider Instance binding;
- “show progress and permission waits” consumes T3 orchestration/projection state rather than a second lifecycle stream;
- “remote control must work” extends T3 clients/connection runtime rather than creating another transport.

### Provider-specific CLI wrappers

Legacy wrappers for Claude/Codex login, home-directory isolation, process launch, and session handling should not be copied if T3 already implements the behavior.

Their useful output is a requirements list:

- multiple accounts of one provider;
- exact identity selection;
- isolated OAuth/config homes where needed;
- API-key accounts;
- custom endpoints;
- authentication status and reauthentication;
- no silent fallback between identities.

Axis Next implements those requirements through Provider Accounts mapped to T3 provider instances.

### Exact legacy UI

Screenshots and old components may inform workflow design, but they are not acceptance criteria. T3 already provides a different navigation/component/runtime structure.

Port capabilities such as “weekly calendar”, “account picker”, “today view”, or “permission notification”; rebuild them natively in the new surface.

## What should be preserved as product semantics

### Company isolation

Legacy Axis correctly treated Company as a product/isolation concept rather than a mutable provider label. Keep that principle.

Company membership must be explicit and stable. Account display names, workspace paths, provider organizations, and CLI config directories are not Company identity.

### Exact account identity

Legacy Axis learned that a provider brand is not an account. `Anthropic`, `OpenAI`, and `OpenRouter` are service families; actual work must route through a specific identity/credential.

That distinction becomes the Axis ProviderAccount domain.

### Work Hub provenance

The legacy Work Hub normalized calendar/ticket/message records and attached source/account provenance. Keep that architecture.

A global view may merge normalized results, but the records must retain the source account/company/workspace needed to prevent cross-company confusion and to route follow-up actions safely.

### Shared Memory ownership

Legacy Project Memory treated provider/model/account as provenance rather than the ownership key for project knowledge. Preserve the principle while adapting the scope to the new Company/Workspace/Repo model.

Shared Memory must never persist hidden chain-of-thought. It should store explicit summaries, decisions, facts, handoffs, references, and derived structured events that are appropriate to share across agents.

## Provider account migration

Legacy Axis credentials must not be copied directly into new database fields.

A migration should produce:

```text
legacy connection/profile metadata
  -> ProviderAccount metadata
  -> AuthenticationConfiguration metadata
  -> secure secret import/reference, when explicitly supported
  -> RuntimeConfiguration
  -> T3 ProviderInstance binding
```

Raw tokens/API keys are never migration metadata.

OAuth-owned CLI profiles should preferably remain owned by their official runtime. If a legacy profile points to a valid `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, migration may register that location as runtime configuration rather than extracting credentials from it.

API-key migration requires a secure-store path designed and tested in the Provider Accounts PR. Until then, do not import API keys automatically.

## Work Hub migration

The old Work Hub implementation should be mined for:

- normalized calendar/ticket/message shapes;
- immutable provenance fields;
- account-bound source configuration;
- bounded connector access;
- stale-while-revalidate behavior;
- failure states and sync observability.

Do not port:

- renderer-to-CLI generic execution surfaces;
- old desktop IPC merely because a collector used it;
- credential management coupled directly to the collector;
- provider-specific normalized UI types where a generic Axis contract is sufficient.

## Shared Memory migration

Do not import old memory data until the new ownership and redaction contracts are stable.

Before migration, classify each legacy memory record by:

- Company;
- Workspace;
- repository/root identity;
- source session/provider account;
- record kind;
- sensitivity/redaction status;
- whether the content is safe and useful to share across agents.

Records without a reliable ownership mapping should remain unimported rather than being attached to the wrong Company.

## Migration sequence

Migration is intentionally late in the roadmap because importing data into unstable models creates permanent compatibility debt.

Recommended order:

1. establish fork architecture;
2. implement Companies and Workspaces;
3. implement Provider Accounts and secure credential handling;
4. implement Agent Session metadata;
5. implement Shared Memory;
6. implement Work Hub/Calendar and later orchestration/notifications;
7. define deterministic legacy import mappings;
8. run read-only discovery/reporting against legacy data;
9. require explicit migration/import actions for sensitive account data;
10. verify counts, ownership, and referential integrity;
11. remove temporary compatibility bridges.

## Per-feature migration checklist

Before copying any legacy code:

1. State the user-visible capability being preserved.
2. Identify the T3 primitive that now owns the infrastructure.
3. Apply one classification: KEEP, PORT, MERGE, REPLACE_WITH_T3, DELETE.
4. List the legacy data that actually needs migration.
5. Define new stable IDs and ownership boundaries.
6. Define secret/sensitive-data treatment.
7. Define desktop/web/mobile implications.
8. Implement the smallest new Axis layer.
9. Test that the feature does not silently fall back across Company/account/runtime boundaries.
10. Delete temporary migration code once the migration window closes.

## Stop conditions

A migration approach should be rejected if it requires any of the following without a newly approved architecture decision:

- reviving the legacy AgentRuntime as a second execution engine;
- copying legacy filesystem/Git/terminal infrastructure;
- extracting OAuth tokens from official provider credential stores;
- storing API keys in plaintext Axis data;
- redefining T3 Project/Thread/ProviderInstance to match legacy names;
- importing legacy data whose Company/account ownership cannot be established;
- preserving an old UI or persistence format solely to reduce short-term porting effort.

Axis Next should become simpler than legacy Axis in infrastructure while becoming richer in product-level organization and orchestration.
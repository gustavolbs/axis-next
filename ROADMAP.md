# Axis Next roadmap

This checklist is the implementation source of truth for Axis Next. An item is checked only when
its applicable contract, server behavior, client behavior, reverse state, and focused tests are in
place. “Partial” means useful infrastructure exists, but the user outcome is not complete yet.

## Product and architecture foundation

- [x] Establish T3 Code as the execution foundation and Axis as the product/organization layer.
- [x] Document the rule “extend T3; do not duplicate it”.
- [x] Keep T3 as the owner of providers, Projects, Threads, Turns, sessions, approvals, terminal,
      filesystem, Git, worktrees, orchestration, RPC, relay/tunnel, desktop, web, and mobile runtime.
- [x] Create Axis architecture, context, Work Hub, learning, upstream, and legacy-migration docs.
- [x] Keep Axis-specific server code under `apps/server/src/axis` and wire schemas through the
      existing contracts and client-runtime packages.
- [ ] Reconcile the remaining Axis Legacy capabilities and data using KEEP / PORT / MERGE /
      REPLACE_WITH_T3 / DELETE decisions.
- [ ] Add a repeatable upstream-sync release checklist and validate every Axis PR against upstream.

## Personal, Companies, Workspaces, and isolation

- [x] Persist one Personal context and multiple isolated Company contexts.
- [x] Assign provider instances to exactly one owning context.
- [x] Grant a Personal provider to a Company without granting Personal data or another Company's
      data.
- [x] Revoke provider grants and remove dependent Work Hub source bindings.
- [x] Bind environment-qualified T3 Projects to an Axis context.
- [x] Remove Project bindings when their Company is removed.
- [x] Enforce context, Project, provider ownership/grant, and local environment for scheduled agent
      launches.
- [ ] Enforce `(contextId, environmentId, projectId/threadId)` on every ordinary Thread creation,
      continuation, provider selection, search, notification, and projection path.
- [ ] Materialize the effective MCP/skill/instruction/preference set at every provider adapter launch
      so ambient provider files cannot bypass Company policy.
- [ ] Prevent Thread/session continuation across context boundaries.
- [ ] Add Company policy that can forbid Personal providers or restrict models/capabilities.
- [ ] Add Axis Workspaces as context-owned groupings of existing environment-qualified T3 Projects.
- [ ] Add optional Profiles only after their real sharing semantics are validated; Profiles must not
      become another provider/runtime.
- [ ] Reconcile deletion and revocation transactionally across cached Work Hub data, schedules,
      learning data, notifications, and derived memory.

## Providers, authentication, API keys, and fallback

- [x] Reuse T3 provider drivers and multiple provider instances instead of introducing an
      AxisProvider abstraction.
- [x] Add Codex/OpenAI API-key provider instances using `OPENAI_API_KEY`.
- [x] Add Claude API-key provider instances using `ANTHROPIC_API_KEY`.
- [x] Store API keys in the environment secret store and redact them from client-visible settings.
- [x] Isolate API-key provider homes so subscription credentials cannot silently override the key.
- [x] Persist explicit credential-source metadata (`cli` or `api-key`).
- [x] Mark API-key instances with an **API billed** boundary in provider settings.
- [x] Support manual fallback by selecting the API-key provider instance when subscription quota is
      exhausted.
- [x] Normalize authoritative Codex and Claude quota signals as a typed `quota-exhausted` runtime
      failure; unknown and non-quota failures remain unclassified.
- [ ] Configure an explicit primary → fallback relationship, disabled by default and reversible.
- [ ] Show and require acceptance of the paid-API boundary before enabling automatic fallback.
- [ ] Implement a one-attempt, quota-only failover with idempotency and protection against duplicate
      tool/file/source-system side effects.
- [ ] Preserve or safely hand off Thread/provider continuation state across isolated provider homes.
- [ ] Return to the subscription provider after quota reset without silently changing an active
      Thread's identity.
- [ ] Extend the API-key preset UX to additional compatible provider drivers when their adapters
      define a supported environment variable and isolation strategy.

## Provider-owned MCPs, skills, instructions, and preferences

- [x] Model capabilities as provider-owned rather than Company-owned.
- [x] Show separate MCP and Skills sections for each provider instance.
- [x] Discover registered MCPs and skills from connected Codex and Claude providers.
- [x] Enable, disable, and remove registered capabilities from the Axis catalog.
- [x] Disable dependent Work Hub sources when an MCP is disabled or removed.
- [x] Preserve the native provider configuration when removing only the Axis catalog entry.
- [ ] Add, configure, authenticate, test, reconnect, enable, disable, and remove MCPs through typed
      provider-adapter operations; mark active only after native confirmation.
- [ ] Install, create, inspect, update, enable, disable, and uninstall skills through provider
      adapters.
- [ ] Implement real Instructions and Preferences management surfaces.
- [ ] Display native connector health, authorization state, permission scope, load errors, and last
      successful check.
- [ ] Support provider-owned capability management consistently from remote web and mobile clients.

## Work Hub foundations

- [x] Implement Overview, Calendar, Messages, Work Board, and Scheduled views on web/desktop.
- [x] Let the user select the provider and individual MCP sources used by each context.
- [x] Persist per-source collection policy and cache TTL.
- [x] Set the minimum/default cache duration to eight hours.
- [x] Keep caches source-scoped and context-scoped with cursors and atomic replacement.
- [x] Provide individual manual **Sync** controls for each selected MCP.
- [x] Resolve manual sync entirely on the server from `sourceId`; reject spoofed context, provider,
      capability, policy, cursor, environment, revoked grant, disabled source, and disabled provider.
- [x] Remove the public arbitrary cache-replacement RPC.
- [x] Validate that a provider-returned snapshot matches its catalog source binding before storing it.
- [x] Refresh an open Work Hub on window return and with bounded active-view polling.
- [x] Complete the shared per-source sync coordinator so manual/manual and manual/scheduled races
      cannot persist an older result over a newer one.
- [x] Filter cache reads by the current catalog, block late orphan writes, and purge orphan
      snapshots transactionally after context/source/capability removal.
- [ ] Aggregate sources across multiple environments; preserve cached data and report partial
      offline status when one environment is unavailable.
- [ ] Show per-source fresh/stale/error/authorization status and last confirmed success.
- [ ] Add retention limits and cleanup for old cache items, cursors, and sync diagnostics.

## Connector acquisition and relevance

- [x] Apply calendar lookback/lookahead, assigned-work-only, direct-message, mention, assigned-ticket
      comment, and cache policies to provider collection requests.
- [x] Merge incremental messages without erasing still-relevant cached items.
- [ ] Replace prompt-only connector behavior with deterministic normalizers/adapters for Google
      Calendar, Microsoft 365, Slack, and Jira.
- [ ] Google Calendar: collect only the configured recent/future event window, recurrence updates,
      cancellations, meeting links, all-day events, and source timezone.
- [ ] Microsoft 365: collect the same relevant calendar window with Teams join links and pagination.
- [ ] Slack: collect DMs, mentions, relevant threads/replies, stable user identity, and pagination.
- [ ] Jira: collect issues assigned to the connected user and new comments/updates on those issues.
- [ ] Add sanitized fixtures for real connector response shapes, pagination, authorization expiry,
      rate limits, malformed records, and incremental cursors.
- [ ] Add opt-in integration smoke tests for every supported connector/provider combination.

## Overview and Messages

- [x] Include today's meetings and important messages across all selected contexts.
- [x] Include active Work Board items in Overview rather than excluding every task.
- [x] Preserve context labels and deep links on aggregate items.
- [ ] Add priority/ranking rules, deduplication across connector notifications, dismiss/read state,
      and source-confirmed mutations.
- [ ] Add message reply and Jira-comment actions with approval, idempotency, and source confirmation.

## Calendar

- [x] Render a weekly time grid with hour labels.
- [x] Navigate to previous/current/future weeks.
- [x] Show a current-time indicator.
- [x] Color events by Personal/Company context and show a context legend.
- [x] Provide meeting **Join** actions and event-detail tooltips.
- [x] Lay out overlapping events in deterministic side-by-side columns.
- [ ] Model and render all-day and multi-day events.
- [ ] Preserve source timezone and clearly convert it to the viewer timezone.
- [ ] Add participants, calendar identity, organizer, response status, recurrence, and cancellation to
      the normalized contract.
- [ ] Add integrated component tests for event positioning, overlaps, week boundaries, DST, join
      links, tooltips, and context colors.
- [ ] Add source-confirmed accept/decline/tentative actions.

## Work Board

- [x] Render TO DO, WORKING, BLOCKED, CODE REVIEW, QA, and DONE columns.
- [x] Keep unknown statuses visible in an Unmapped lane instead of silently treating them as To do.
- [x] Preserve context color, source status, summary, and deep link.
- [ ] Add explicit per-connector status mappings with a mapping-management UI.
- [ ] Extend normalized cards with assignee, priority, due date, labels, project, and update time.
- [ ] Move cards through source-confirmed Jira/work-management mutations with approval and
      idempotency.
- [ ] Add board filtering, ordering, search, pagination/virtualization, and mobile presentation.

## Scheduled activities

- [x] Persist interval and weekly schedules with timezone, enabled state, next run, and history.
- [x] Schedule one or several selected Work Hub MCP sources.
- [x] Pause, resume, edit, delete, run now, and inspect per-source outcomes.
- [x] Run independent sources without one failure erasing another source's last good cache.
- [x] Skip still-fresh cache during automatic runs while making **Run now** force a collection.
- [x] Recover persisted `running` executions as failed after a server restart so they can be retried.
- [x] Create scheduled agent work as a real T3 Thread and first Turn in approval-required mode.
- [x] Restrict scheduled agent work to a context-bound local Project and an owned/granted local
      provider.
- [x] Link successful scheduled agent runs to their created Thread.
- [ ] Track the eventual Turn outcome separately from the successful dispatch/start outcome.
- [ ] Add notification/delivery destinations and quiet-hours policy.
- [ ] Support distributed scheduling for provider sources and Projects owned by another connected
      environment without duplicating execution.
- [ ] Generalize the narrow Axis timer into a reusable T3 scheduling primitive when multiple T3
      features need it.

## Remote dispatch

Remote dispatch means starting and supervising work on the environment that owns the target Project
and credentials, comparable to Claude/Codex remote or cloud task dispatch. It must reuse T3's
connection/orchestration runtime rather than add an Axis transport.

- [x] Reuse T3 authenticated RPC, environment scoping, relay/tunnel connectivity, Projects, Threads,
      provider instances, approvals, events, and checkpoints as the foundation.
- [ ] Add a dispatch composer that selects Axis context, connected environment, Project, provider,
      model, branch/worktree policy, runtime mode, and task prompt.
- [ ] Authorize the effective context/provider/Project binding on the destination server, not only in
      the initiating client.
- [ ] Create the remote Thread/Turn through the normal orchestration commands and return a stable
      environment-qualified Thread reference immediately.
- [ ] Stream queued/running/needs-attention/completed/failed/cancelled state to web, desktop, and
      mobile.
- [ ] Support explicit cancel, retry, continue, archive, open, and handoff operations.
- [ ] Preserve approvals and user questions as actionable remote states with notifications.
- [ ] Keep credentials, repositories, MCP calls, filesystem access, and checkpoints exclusively on
      the destination environment.
- [ ] Handle offline destinations with an explicit queued/not-dispatched state, expiry, and safe
      retry; never duplicate a dispatch after reconnect.
- [ ] Support dispatch to an existing checkout or isolated worktree and expose resulting diffs,
      checks, artifacts, and PR links.
- [ ] Add multi-agent fan-out/coordination above ordinary T3 Threads with bounded concurrency,
      per-agent context, cancellation, and aggregate progress.
- [ ] Add end-to-end tests for LAN, relay/tunnel, reconnect, multi-device observation, duplicate
      prevention, authorization failure, cancellation, and destination restart.

## Learning Layer and Hermes

- [x] Define Hermes as an optional learning engine, not a provider, permission system, scheduler, or
      self-modifying runtime.
- [x] Define context isolation, provenance, proposal review, immutable versions, evaluation,
      activation, rejection, and rollback in the architecture.
- [x] Implement engine-independent evidence, provenance, proposal, immutable version, lifecycle,
      active-version, retention, and typed-error contracts.
- [x] Persist those records with context indexes, evidence deduplication, expiry, and database-level
      immutability for versions/audit events.
- [x] Require explicit submit/review/approve and separate explicit activation; approval never
      autoactivates a proposal.
- [x] Audit rollback and preserve the last known-good immutable version.
- [x] Expose the Learning store through authorized RPC and client-runtime state.
- [x] Add Settings → Axis → Learning UI for evidence, proposal review, approve/reject, version
      activation, rollback, and audit history.
- [ ] Add prompt-injection/content-safety gates before evidence can influence a proposal.
- [ ] Add evaluation policies and outcome monitoring for skills, instructions, Work Hub collection
      policy, and scheduled-activity improvements.
- [ ] Connect Hermes behind a replaceable engine adapter for offline proposal generation.
- [ ] Require policy-checked, explicit promotion before any learned change crosses contexts.
- [ ] Add retention, export, delete, and Company-policy controls for learning evidence.

## Shared Memory, Chat, Cowork, and notifications

- [x] Keep Chat and Cowork as presentations over the same canonical T3 Thread/Turn lifecycle.
- [ ] Add context-scoped Shared Memory derived from T3 history with source provenance, processing
      cursors, retention, deletion propagation, and no cross-Company retrieval.
- [ ] Add a memory review/edit/delete/export surface and provider-independent retrieval contract.
- [ ] Define the simpler Cowork/task presentation without creating a second conversation engine.
- [ ] Project Work Hub items and scheduled activities into Chat/Cowork without copying Threads.
- [ ] Add actionable notifications for scheduled runs, remote approvals/questions, connector auth
      expiry, blocked work, reviews, and meetings.
- [ ] Add notification preferences, quiet hours, deduplication, read/dismiss, and deep links.

## Multi-surface and remote environments

- [x] Keep Axis web behavior compatible with the desktop wrapper.
- [x] Use environment-scoped RPC and client-runtime atoms for implemented Axis server features.
- [ ] Add native mobile navigation and read views for Contexts, Work Hub, Calendar, Messages, Board,
      Scheduled Activities, and Learning.
- [ ] Add mobile mutations only where the destination environment reports support and authorization.
- [ ] Make every implemented flow behave correctly for local, LAN, relay/tunnel, offline, reconnect,
      multiple environments, and multiple observing devices.
- [ ] Add version-skew fallbacks for clients connected to servers without newer Axis capabilities.

## Reliability, performance, security, and release quality

- [x] Add focused contract, migration, store, runner, adapter, settings-logic, and Work Hub tests for
      implemented slices.
- [x] Keep API secrets out of Axis databases and client-visible settings.
- [x] Make manual Work Hub sync server-authoritative.
- [x] Complete source-level single-flight/monotonic cache writes and test races without sleeps.
- [ ] Make catalog updates and dependent cache/schedule cleanup transactional or reconciled.
- [ ] Add scheduler retention for old run history and bounded diagnostics.
- [ ] Add metrics/logging for connector duration, cache hit/skip, failures, scheduled drift, dispatch,
      and learning lifecycle without logging secrets or Company data.
- [ ] Add integrated web verification with screenshots for user-visible changes after explicit browser
      permission.
- [ ] Add native mobile verification for Axis changes when the mobile surface is implemented.
- [ ] Run focused checks on every change and let CI own repository-wide suites.
- [ ] Keep this roadmap synchronized: check an item only after its acceptance behavior is tested and
      remove or rewrite entries when the product decision changes.

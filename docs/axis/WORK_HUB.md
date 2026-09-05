# Work Hub

## Purpose

Work Hub is the user's cross-context view of the day. It gathers work data from Personal and every
connected Company while preserving each context as an isolation boundary.

Work Hub is not a new agent runtime, orchestration engine, calendar backend, chat store, or issue
tracker. It is an Axis projection of data obtained through MCPs available to provider bindings in
each context, combined with relevant T3 work state.

Open **Work Hub** from the main sidebar to switch between Overview, Calendar, Messages, and Work
Board. The surface reports provider/MCP readiness per context and renders the last confirmed data
cached for each selected source.

In Overview, **Work Hub sources** lets the user opt in per context, then per available provider and
MCP. Provider access and MCP selection are separate decisions: granting a Personal provider to a
Company makes its MCPs eligible, but Work Hub does not query them until the user selects them for
that Company. Each selected MCP has its own **Sync** action.

## Primary views

### Overview

Overview summarizes what matters today across Personal and all connected Companies. It may include
upcoming events, important messages, active and blocked work, reviews awaiting attention, and tasks
due today.

Each card retains its source context and system. The default view may combine cards visually, but a
Company's content is never inserted into another Company's model context to produce the summary.

### Calendar

Calendar presents Personal and Company events in a familiar Teams, Outlook, or Google Calendar-style
view. Events are normalized for layout and filtering while retaining their native source ID,
calendar, participants, time zone, status, deep link, and source context.

Overlapping events from different contexts may appear together for the user. Visibility in the
combined calendar does not grant either Company access to the other event. Sensitive details may be
reduced to availability when source or Company policy requires it.

### Messages

Messages is an attention inbox, not a replacement for Slack, Jira, or another communication tool. It
surfaces important items such as mentions, direct messages, review requests, incident updates, or
Jira notifications selected by the context's configured provider/MCP flow.

Items retain their native source reference and deep link. Read, dismiss, reply, or other mutations
must be sent back through the originating context and connector when supported; local Work Hub state
must not pretend the source system changed.

### Work Board

Work Board normalizes work from Jira or the Company's selected work-management MCP into these Axis
columns:

```text
TO DO → WORKING → BLOCKED → CODE REVIEW → QA → DONE
```

Each connector owns an explicit mapping from native statuses to Axis columns. The normalized card
retains its native issue ID, original status, source context, assignee, priority, due date, deep link,
and last synchronization cursor. Unsupported or ambiguous statuses must remain visible for mapping;
they are not silently guessed.

Moving a card is a source-system mutation. When enabled, it runs through the originating
provider/MCP binding, uses T3 approvals where applicable, and is considered complete only after the
source confirms the new state and the projection observes it.

## Data path

All external Work Hub data comes through MCPs connected to provider bindings in the relevant
context:

```text
Context-scoped refresh or user action
  → dedicated ephemeral read routed to an allowed provider instance
  → context-approved MCP invocation
  → provider result with source references
  → validated Axis normalization
  → context-owned Work Hub projection
  → user-facing aggregate view
```

This reuses T3 provider instances, provider credentials, and remote RPC. Manual collection runs in
an ephemeral provider process without creating a visible Thread or durable provider session. Axis
adds focused collection policy, validated normalization, and the Work Hub read model. It does not
scrape provider session files or call a Company connector from Personal.

The normalized record should include at least:

- `contextId` and source Company/Personal label;
- the T3 environment, Project, Thread, and Turn provenance used for acquisition when applicable;
- provider instance and MCP connector identity;
- native entity ID, source timestamp, deep link, and synchronization cursor;
- normalized fields needed by the relevant view; and
- freshness, error, and permission state.

Provider prose alone is not durable source data. Connector results used to update projections must
be validated into capability-specific schemas and retain enough native identity to reconcile,
deduplicate, retry, and delete them.

## Isolation and aggregation

Collection and storage happen per context. The aggregate Work Hub is assembled for the signed-in
user from already authorized context projections.

- Company A refreshes only with provider bindings available to Company A and the MCPs attached to
  those providers.
- Company B refreshes only with provider bindings available to Company B and the MCPs attached to
  those providers.
- Personal refreshes only with Personal bindings.
- A personal provider granted to Company B executes inside Company B's effective binding; its result
  belongs to Company B and is not added to Personal memory or Company A.
- Search, caches, notifications, and background refresh jobs are keyed by context.
- An offline or unauthorized context reports stale/unavailable state without blocking other
  contexts or leaking its last payload into them.

Cross-context AI synthesis is not implied by showing cards together. If introduced later, it must be
an explicit Personal action with visible source selection and policy checks; it cannot become an
ambient Company-to-Company data path.

## Refresh and writes

Work Hub begins as a read projection. Manual sync uses the context-scoped acquisition path and
passes the last cursor and refresh timestamp to the provider. A failure in one connector is shown
against that source and does not discard the last confirmed snapshot.

Fetched data is cached by `(contextId, providerInstanceId, mcpCapabilityId)` for at least eight
hours. Normal reads serve the last confirmed snapshot without calling the MCP. Manual **Sync**
refreshes one selected MCP and does not erase the visible snapshot while its request is running.
Successful results atomically replace that source snapshot and advance its cursor; recent
incremental messages are merged so a later sync does not erase still-relevant DMs, mentions, or
assigned-ticket comments. A failure keeps the prior snapshot and allows an individual retry. Cache
records remain context-keyed so deduplication cannot create a cross-Company data path.

Source mutations—calendar responses, message replies, issue transitions, assignments—are separate
capabilities. Each needs typed input/output, authorization, approval behavior, an idempotency key,
and confirmation from the source. They should not be inferred as part of the initial read model.

## Relationship to Chat and Cowork

A Work Hub item may open its supporting T3 Thread in Chat or a task-focused Cowork presentation.
Neither action copies the item into a new conversation model. Follow-up work uses a Thread in the
item's source context and only the provider/MCP bindings allowed there.

The UI, persisted source selection, per-source cache policy, cache store, and manual Codex/Claude MCP
sync are implemented. Scheduled refresh, provider adapters beyond Codex and Claude, richer
connector-specific mappings, source-system writes, and a native mobile presentation remain later
implementation slices.

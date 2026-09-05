# Work Hub

## Purpose

Work Hub is the user's cross-context view of the day. It gathers work data from Personal and every
connected Company while preserving each context as an isolation boundary.

Work Hub is not a new agent runtime, orchestration engine, calendar backend, chat store, or issue
tracker. It is an Axis projection of data obtained through MCPs available to provider bindings in
each context, combined with relevant T3 work state.

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
  → T3 Thread/Turn routed to an allowed provider instance
  → context-approved MCP invocation
  → provider result with source references
  → validated Axis normalization
  → context-owned Work Hub projection
  → user-facing aggregate view
```

This reuses T3 provider instances, Threads, Turns, approvals, activities, event persistence, and
remote RPC. Axis adds the connector-specific normalization and Work Hub read model. It does not
scrape provider session files, call a Company connector from Personal, or create a second provider
session lifecycle.

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

- Company A refreshes only with Company A provider bindings and MCP grants.
- Company B refreshes only with Company B provider bindings and MCP grants.
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

Work Hub should begin as a read projection. Refreshes can be manual or scheduled later, but both use
the same context-scoped acquisition path and idempotent cursors. A failure in one connector is shown
against that source and does not discard the last confirmed snapshot.

Source mutations—calendar responses, message replies, issue transitions, assignments—are separate
capabilities. Each needs typed input/output, authorization, approval behavior, an idempotency key,
and confirmation from the source. They should not be inferred as part of the initial read model.

## Relationship to Chat and Cowork

A Work Hub item may open its supporting T3 Thread in Chat or a task-focused Cowork presentation.
Neither action copies the item into a new conversation model. Follow-up work uses a Thread in the
item's source context and only the provider/MCP bindings allowed there.

This document defines the Work Hub boundary and information model. It does not implement ingestion,
background refresh, connector mappings, UI, or source-system writes.

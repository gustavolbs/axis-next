# Changelog

## [0.1.0] - 2026-09-07

### Added

- Show Work Hub source freshness, authorization failures, sync errors, and the last confirmed successful refresh without discarding the last good cache.
- Render all-day and multi-day calendar events using source-provided civil dates and expose assignment, priority, due date, labels, project, and update details on Work Board cards.
- Show calendar provenance, participants, recurrence, cancellation, and source/viewer time zones.
- Preserve calendar identity, source timezone, organizer, participants, responses, recurrence, and cancellations, with explicit viewer-time conversion.

### Changed

- Publish signed macOS releases automatically after changes reach main and pass CI.
- Require a new stable version and matching changelog entry for each pull request, and use that entry as the GitHub Release notes.
- Remove orphaned Work Hub caches, schedules, run history, and context-owned learning data atomically when the Axis catalog changes.

### Fixed

- Standalone chats use the same conversation screen as project threads, grouped under Chats in the sidebar, without creating hidden projects. Preserve existing histories and archive controls.
- Apply desktop exposure changes by restarting the backend while keeping the window open.
- Open mobile pairing links directly in the app and improve provider capability controls.
- Remove dependent schedules and learning data when their context is deleted, and discard invalid scheduled source bindings.

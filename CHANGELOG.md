# Changelog

## [0.2.4] - 2026-09-09

### Fixed

- Use a source-specific prompt as the sole Work Hub collection criterion.

## [0.2.3] - 2026-09-08

### Fixed

- Run the mobile fingerprint PR check on the standard Ubuntu runner so it is not blocked by the unavailable Blacksmith queue.

## [0.2.2] - 2026-09-08

### Added

- Add explicit provider metric availability, stable prompt-prefix handling, an optional external Caveman record adapter, bilingual benchmark fixtures, and an aggregate-only Hermes evidence bridge.
- Compact structured accessibility-tree text leaves with context-scoped recovery metadata.

### Changed

- Keep external token-efficiency engines fail-open and record-only until reviewed task-quality and provider-billed A/B results justify rollout.

## [0.2.1] - 2026-09-07

### Added

- Add opt-in token-efficiency controls, aggregate provider baselines, deterministic MCP result compaction with recovery handles, and diagnostics in Settings.
- Add an optional concise-output profile across Codex, Claude Code, Cursor, Grok, OpenCode, and Antigravity.

## [0.2.0] - 2026-09-07

### Changed

- Reorganize Axis settings, Learning, Capabilities, and Work Hub into clearer task-focused layouts with persistent views, at-a-glance status, and safer destructive actions.

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

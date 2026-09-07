# Changelog

## [0.1.0] - 2026-09-07

### Added

- Show Work Hub source freshness, authorization failures, sync errors, and the last confirmed successful refresh without discarding the last good cache.
- Render all-day and multi-day calendar events using source-provided civil dates and expose assignment, priority, due date, labels, project, and update details on Work Board cards.

### Changed

- Publish signed macOS releases automatically after changes reach main and pass CI.
- Require a new stable version and matching changelog entry for each pull request, and use that entry as the GitHub Release notes.

### Fixed

- Standalone chats no longer create hidden projects. Keep conversation history and streaming responses independently, including when clients disconnect.
- Apply desktop exposure changes by restarting the backend while keeping the window open.
- Open mobile pairing links directly in the app and improve provider capability controls.

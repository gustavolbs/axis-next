# Changelog

## [0.0.39] - 2026-09-07

### Changed

- Publish signed macOS releases automatically after changes reach main and pass CI.
- Require a new stable version and matching changelog entry for each pull request, and use that entry as the GitHub Release notes.

### Fixed

- Standalone chats no longer create hidden projects. Keep conversation history and streaming responses independently, including when clients disconnect.
- Apply desktop exposure changes by restarting the backend while keeping the window open.
- Open mobile pairing links directly in the app and improve provider capability controls.

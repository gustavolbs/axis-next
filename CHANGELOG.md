# Changelog

## [0.12.7] - 2026-09-11

### Fixed

- Preserve a real provider execution id when `thread.started` arrives before
  the domain turn-start event, and resolve the recorded provider from the
  selected instance or session instead of hardcoding OpenCode.
- Document the remaining boundary: internal OpenCode worker/reviewer
  sessions are not yet registered as child runs by the Axis ingestion path,
  and the current registry is process-local.

## [0.12.6] - 2026-09-11

### Added

- Server-owned agent identity: `AgentRunId` (minted by the router at
  dispatch) and `ProviderExecutionId` (the real OpenCode session id when
  the provider surfaces one) wired through a new `AgentRunRegistry`
  service in `apps/server/src/orchestration/Services/AgentRunRegistry.ts`.
  The runtime ingestion layer mints a `main` run on
  `thread.turn-start-requested`, attaches the real provider id when
  `thread.started` carries a non-placeholder `providerThreadId`, and
  marks the run `completed` / `cancelled` on terminal turn events.
- Placeholder rejection helpers (`isPlaceholderProviderExecutionId`,
  `providerExecutionIdFrom`) so probe responses like `<id>`, `<model>`,
  `placeholder`, `unknown`, `synthetic` and empty strings never promote
  themselves to a `ProviderExecutionId`.
- Focused tests covering the full invariant set:
  server-minted id, real provider id acceptance, placeholder rejection,
  sticky terminal status across cancel / retry / compaction, worker vs
  reviewer distinction, late `providerExecutionId` patches, and
  per-thread run lookup. 10 new contract tests, 15 new registry tests,
  14 new ingestion-hook tests.

### Fixed

- Repair the `projectOverviewIntegration.test.ts` fixture to match the
  current `AxisContextCatalog` schema (`providerOwnerships`,
  `providerAccessGrants`, `kind`, `createdAt`, `updatedAt` on
  `AxisContext`).

## [0.12.5] - 2026-09-11

### Added

- Integrate the parallel RouteMux worker slice: testable Jira and Trello write adapters, scoped task intake, PR plan + delivery, review evidence + feedback, verification evidence, and Hermes-driven learning evidence plumbing through the scheduler X12 path.
- Integrate the parallel Codex slice: pin Hermes (`NousResearch/hermes-agent` 0.21.1 with source digests), persist and reconcile versioned Learning outcomes, materialize effective Axis instructions for both Codex and Claude, and surface the X12 scheduled activity runner.
- Integrate the parallel web slice: per-project Learning review panel (U06), label legacy vs per-project Learning groups in Settings (U07), Escape-to-back on the project Overview shell (U02), and the project Learning panel mount in the Overview (I03).
- Cover project Overview scope resolution end-to-end (controlled-transport / out-of-order / conflict cases).

### Fixed

- Align the new task/workflow Context.Service declarations with the `Context.Service<Self, Interface>()(...)` Self-type + deterministic-key contract that the Effect language service requires.
- Replace `Schema["Type"]` lookups, `Math.random()`, `new Date()`, untagged `new Error()`, and `Schema.decodeUnknownSync` inside Effect generators with the typed Effect equivalents.
- Teach the Work Hub scheduled activity editor to render the server-managed `learningAnalysis` action without fabricating it from the UI.

## [0.12.4] - 2026-09-11

### Fixed

- Add focused coverage for project-scoped profile uniqueness, Learning revision preservation, and server scope validation.

## [0.12.3] - 2026-09-11

### Changed

- Keep RouteMux subagent selection scoped to locally managed OpenCode servers and document the external-server configuration requirement.

## [0.12.2] - 2026-09-10

### Added

- Allow explicit RouteMux model mentions in OpenCode prompts to run as dynamically configured subagents.

## [0.12.1] - 2026-09-10

### Changed

- RouteMux OpenCode now builds its model catalog only from the live RouteMux listing, filters unrelated OpenCode providers, and does not assign a hardcoded model by agent role.

## [0.12.0] - 2026-09-10

### Added

- Add a RouteMux OpenCode gateway preset that uses OpenAI-compatible Chat Completions, live tool-capable model discovery, and no Claude models.

## [0.11.2] - 2026-09-10

### Added

- Add a RouteMux Codex gateway preset that routes OpenAI Responses-compatible models through the Codex CLI with isolated credentials and live tool-capable model discovery.

## [0.11.1] - 2026-09-10

### Added

- Persist project-scoped learning evidence from a canonical completed or failed WorkHub task attempt via the new `axis.taskFeedback.record` RPC, exposed in `ProjectOverview` and `ProjectWorkflowPanel`.

### Changed

- Route authorization rejects task-feedback requests from environments that are not bound to the targeted project scope, with a dedicated `AxisTaskFeedbackError`.

## [0.11.0] - 2026-09-10

### Added

- Preview the exact server-resolved project rules, source references, learning versions, conflicts, and digest for a provider, workflow step, and path selection.

## [0.9.0] - 2026-09-10

### Added

- Run project task intake, impact analysis and planning with durable attempts, canonical document artifacts, explicit cancellation and failure retry from Overview.

## [0.8.0] - 2026-09-10

### Added

- Inspect context Work Hub sources and synchronization status from the selected physical project, with explicit unavailable states for unsupported scoped navigation.

## [0.7.1] - 2026-09-10

### Fixed

- Restore the applied onboarding state from persisted application receipts after reload so another analysis can start without reapplying earlier decisions.

## [0.7.0] - 2026-09-10

### Added

- Open scoped Learning evidence, proposal review, and version actions from Project overview, with explicit analysis requests through the configured engine.

### Fixed

- Reset Learning drafts when switching context or project, disable disconnected writes, and bound analysis to the latest 32 evidence records.

## [0.6.2] - 2026-09-10

### Fixed

- Normalize WorkHub source formatting reported by CI and use the Effect test harness for the Codex fallback-model regression.

## [0.6.1] - 2026-09-10

### Fixed

- Fence server-update continuation against current provider and project context, preserve uncertain provider effects, and prevent normal turns from racing pending continuation.
- Reject incomplete continuation claims and avoid retaining an unbounded history of dispatched continuation keys.

## [0.6.0] - 2026-09-10

### Added

- Analyze project repositories through the selected provider, review sourced onboarding suggestions, and apply explicit decisions to the project profile.

### Fixed

- Preserve onboarding decisions and evidence atomically, distinguish interrupted analysis from completion, and retry with a separate execution.
- Keep larger project manifests readable and show source truncation or parsing limitations during onboarding.

## [0.5.2] - 2026-09-10

### Fixed

- Isolate Chromium storage and application locks with each development environment so Desktop worktrees do not share a browser profile.

## [0.5.1] - 2026-09-10

### Fixed

- Allow administrative clients to open project profiles and Learning in an existing company context while preserving project and environment validation.

## [0.5.0] - 2026-09-10

### Added

- Open Project overview from both sidebar layouts and move between Overview, Patterns, and project settings while retaining the selected checkout.

### Fixed

- Show project connection and request failures, keep cancellation available during connected analysis, and disable unavailable project features.

## [0.4.0] - 2026-09-09

### Added

- Add project-scoped Axis profiles, portable task contracts, and Learning scope compatibility with revision-preserving persistence migrations.

## [0.3.0] - 2026-09-09

### Added

- Make standalone conversations available through a managed Chats project in each environment, using the existing project and thread protocol for official T3 mobile clients.

### Changed

- Preserve existing chat histories while moving them into Chats, with separate conversation directories and restricted provider execution. Disable workspace edits, terminal sessions, worktrees, setup scripts, and Git checkpoints for Chats.

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

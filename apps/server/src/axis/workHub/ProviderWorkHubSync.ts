import {
  AxisWorkHubCollectionResult,
  AxisWorkHubItemId,
  type AxisWorkHubCacheSnapshot,
  type AxisWorkHubCollectInput,
  type AxisWorkHubCollectedItem,
  type AxisWorkHubCollectionResult as AxisWorkHubCollectionResultType,
  type ClaudeSettings,
  type CodexSettings,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderMcpServer,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { expandHomePath } from "../../pathExpansion.ts";
import { toJsonSchemaObject } from "../../textGeneration/TextGenerationUtils.ts";
import { ProviderDriverError } from "../../provider/Errors.ts";
import { spawnAndCollect } from "../../provider/providerSnapshot.ts";
import {
  codexExecLaunchArgs,
  resolveCodexLaunchArgs,
} from "../../provider/Layers/codexLaunchArgs.ts";

const SYNC_TIMEOUT_MS = 600_000;
const MAX_CACHED_ITEMS_PER_SOURCE = 500;
const INITIAL_MESSAGE_LOOKBACK_DAYS = 14;
// Belt over the prompt's "not finished" instruction: drop board items an agent
// still returns with a terminal status.
const FINISHED_WORK_ITEM_STATUS = /\b(done|closed|resolved|cancell?ed|completed)\b/iu;
const decodeCollectionResult = Schema.decodeEffect(
  Schema.fromJsonString(AxisWorkHubCollectionResult),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const ClaudeStructuredOutput = Schema.Struct({
  structured_output: AxisWorkHubCollectionResult,
});
const decodeClaudeStructuredOutput = Schema.decodeEffect(
  Schema.fromJsonString(ClaudeStructuredOutput),
);
const isProviderDriverError = Schema.is(ProviderDriverError);

export interface ProviderWorkHubSyncOptions {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly availableMcps: ReadonlyArray<ProviderMcpServer>;
}

function findAvailableMcp(options: ProviderWorkHubSyncOptions, name: string) {
  return options.availableMcps.find((server) => server.name === name);
}

function syncError(
  options: Pick<ProviderWorkHubSyncOptions, "driver" | "instanceId">,
  detail: string,
  cause?: unknown,
) {
  return new ProviderDriverError({
    driver: options.driver,
    instanceId: options.instanceId,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

function safeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function itemMatchesPolicy(
  item: AxisWorkHubCollectedItem,
  input: AxisWorkHubCollectInput,
  nowEpochMs: number,
): boolean {
  if (item.kind === "calendar-event") {
    if (item.view !== "calendar" || item.startsAt === null) return false;
    const startsAt = Date.parse(item.startsAt);
    const earliest = nowEpochMs - input.collectionPolicy.calendarLookbackDays * 86_400_000;
    const latest = nowEpochMs + input.collectionPolicy.calendarLookaheadDays * 86_400_000;
    return Number.isFinite(startsAt) && startsAt >= earliest && startsAt <= latest;
  }
  if (item.kind === "assigned-work-item") {
    return (
      input.collectionPolicy.assignedWorkItemsOnly &&
      item.view === "board" &&
      !(item.status !== null && FINISHED_WORK_ITEM_STATUS.test(item.status))
    );
  }
  if (item.view !== "messages" || item.occurredAt === null) return false;
  const occurredAt = Date.parse(item.occurredAt);
  const messageCutoff = input.previousRefreshedAt
    ? Date.parse(input.previousRefreshedAt)
    : nowEpochMs - INITIAL_MESSAGE_LOOKBACK_DAYS * 86_400_000;
  if (!Number.isFinite(occurredAt) || occurredAt < messageCutoff) return false;
  if (item.kind === "direct-message") return input.collectionPolicy.directMessages;
  if (item.kind === "mention") return input.collectionPolicy.mentions;
  return input.collectionPolicy.assignedIssueComments;
}

export function buildAxisWorkHubCacheSnapshot(input: {
  readonly request: AxisWorkHubCollectInput;
  readonly result: AxisWorkHubCollectionResultType;
  readonly nowEpochMs: number;
}): AxisWorkHubCacheSnapshot {
  const { request, result, nowEpochMs } = input;
  const refreshedAt = DateTime.formatIso(DateTime.makeUnsafe(nowEpochMs));
  const deduplicated = new Map<string, AxisWorkHubCollectedItem>();
  for (const item of result.items) {
    if (!itemMatchesPolicy(item, request, nowEpochMs)) continue;
    deduplicated.set(`${item.kind}\u0000${item.nativeId}`, item);
    if (deduplicated.size >= MAX_CACHED_ITEMS_PER_SOURCE) break;
  }
  return {
    sourceId: request.sourceId,
    contextId: request.contextId,
    provider: request.provider,
    capabilityId: request.capabilityId,
    items: [...deduplicated.values()].map((item) => ({
      ...item,
      id: AxisWorkHubItemId.make(`${request.sourceId}:${item.kind}:${item.nativeId}`),
      sourceId: request.sourceId,
      contextId: request.contextId,
      deepLink: safeHttpUrl(item.deepLink),
      meetingLink: safeHttpUrl(item.meetingLink),
      updatedAt: refreshedAt,
    })),
    cursor: result.cursor,
    refreshedAt,
    expiresAt: DateTime.formatIso(
      DateTime.makeUnsafe(nowEpochMs + request.cacheTtlSeconds * 1_000),
    ),
  };
}

export function buildCollectionPrompt(input: AxisWorkHubCollectInput, nowEpochMs: number): string {
  const dayMs = 86_400_000;
  // Compute exact bounds from the source policy so acquisition and the cache
  // filter agree. One contiguous query avoids sequential weekly agent turns.
  const calendarStart = DateTime.formatIso(
    DateTime.makeUnsafe(nowEpochMs - input.collectionPolicy.calendarLookbackDays * dayMs),
  );
  const calendarEnd = DateTime.formatIso(
    DateTime.makeUnsafe(nowEpochMs + input.collectionPolicy.calendarLookaheadDays * dayMs),
  );
  const previousRefreshedAtMs = input.previousRefreshedAt
    ? Date.parse(input.previousRefreshedAt)
    : Number.NaN;
  const messageCutoffMs = Number.isFinite(previousRefreshedAtMs)
    ? previousRefreshedAtMs
    : nowEpochMs - INITIAL_MESSAGE_LOOKBACK_DAYS * dayMs;
  const messageCutoffIso = DateTime.formatIso(DateTime.makeUnsafe(messageCutoffMs));
  const messageCutoffDate = messageCutoffIso.slice(0, 10);
  return `You are performing a read-only Axis Work Hub sync.

Use only tools from the MCP server named ${JSON.stringify(input.mcpName)}. Its tools are deferred, so load them with the built-in ToolSearch tool — but load everything you need in ONE ToolSearch call using the select: form, for example ToolSearch("select:toolA,toolB"). On the common connectors the exact tool names are already known, so select them directly instead of exploring:
- Jira: jira_search
- Microsoft 365 / Outlook: outlook_calendar_search
- Slack: slack_search_public_and_private
Only if a select: load returns nothing for a category, fall back to a single keyword ToolSearch (max_results 50) for that category alone. The only other built-in tool you may use is Read, and only when Claude materializes this MCP's response as a tool-results file; read exactly that generated result file and no other path. Never use shell, browser, web search, another MCP, or any mutating tool. Never create, update, send, delete, respond to, modify, or acknowledge anything.

Issue every independent read in the SAME block so they run in parallel — the calendar, board, and message queries do not depend on each other. Do not serialize them, do not re-run a query that already returned, and do not keep searching once each category has been answered.

Collect only categories the MCP actually supports:
- calendar-event / calendar: ONE query covering exactly start: "${calendarStart}" end: "${calendarEnd}" (${input.collectionPolicy.calendarLookbackDays} days back and ${input.collectionPolicy.calendarLookaheadDays} days ahead). Copy those two values VERBATIM into the tool arguments — never infer, round, reformat, widen, or split the range. Include meetingLink and location when available.
- assigned-work-item / board: only work items assigned to the authenticated user that are not finished or closed.
- direct-message / messages: only direct messages to the authenticated user since ${messageCutoffIso}.
- mention / messages: only messages mentioning the authenticated user since ${messageCutoffIso}.
- assigned-issue-comment / messages: only new comments since ${messageCutoffIso} on work items assigned to the authenticated user.

Exact arguments for the known connectors — use them as written, changing nothing but what is noted:
- outlook_calendar_search: query "*", afterDateTime "${calendarStart}", beforeDateTime "${calendarEnd}", order "oldest", limit 25. If a response ends with a nextOffset, repeat the same call with that offset until it stops appearing, so no event is dropped. Teams meetings are calendar events here; the Teams-specific tools only read chat messages.
- jira_search: jql "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC", maxResults 50.
- slack_search_public_and_private: include_context false on every call, plus one query "to:me after:${messageCutoffDate}" for direct messages and one query "<@USER_ID> after:${messageCutoffDate}" for mentions, where USER_ID is the logged-in user id stated in the Slack tool description — do not call another tool to look it up.
For any other connector prefer a search operation with query "*" and the same explicit bounds. Emit every item a call returns — never summarize a result set down to a sample. When a connector returns local times with a time zone, convert them to ISO-8601 with the correct offset. If a list operation returns calendar metadata without an events collection, try the search operation instead of treating that metadata as zero events.

Use stable native IDs. Use null for unavailable optional values. Do not include general channel traffic, other users' tickets, historical calendar data outside the window, or guessed data. Emit only items inside the windows above — anything outside them is discarded on arrival, so returning it only costs time. Return at most ${MAX_CACHED_ITEMS_PER_SOURCE} items and an opaque pagination cursor when the MCP provides one. Previous cursor: ${JSON.stringify(input.previousCursor)}.

Always finish by returning the structured JSON result. If a category has no matching read operation on this MCP, skip that category and still collect the others; an unsupported category is never a reason to abort or to return prose instead of the result.`;
}

function codexMcpKey(name: string): string {
  return `mcp_servers.${JSON.stringify(name)}.enabled`;
}

export const collectCodexWorkHubSource = Effect.fn("collectCodexWorkHubSource")(function* (input: {
  readonly request: AxisWorkHubCollectInput;
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly options: ProviderWorkHubSyncOptions;
}) {
  if (!findAvailableMcp(input.options, input.request.mcpName)) {
    return yield* syncError(input.options, `MCP '${input.request.mcpName}' was not found.`);
  }
  const nowEpochMs = yield* Clock.currentTimeMillis;
  const fileSystem = yield* FileSystem.FileSystem;
  const isolatedCwd = yield* fileSystem
    .makeTempDirectoryScoped({ prefix: "t3-work-hub-codex-" })
    .pipe(
      Effect.mapError((cause) =>
        syncError(input.options, "Failed to create an isolated sync directory.", cause),
      ),
    );
  const schemaPath = yield* fileSystem
    .makeTempFileScoped({ prefix: "t3-work-hub-schema-" })
    .pipe(
      Effect.mapError((cause) =>
        syncError(input.options, "Failed to create Work Hub schema file.", cause),
      ),
    );
  const outputPath = yield* fileSystem
    .makeTempFileScoped({ prefix: "t3-work-hub-output-" })
    .pipe(
      Effect.mapError((cause) =>
        syncError(input.options, "Failed to create Work Hub output file.", cause),
      ),
    );
  const schemaJson = yield* encodeJson(toJsonSchemaObject(AxisWorkHubCollectionResult)).pipe(
    Effect.mapError((cause) =>
      syncError(input.options, "Failed to encode Work Hub schema.", cause),
    ),
  );
  yield* fileSystem
    .writeFileString(schemaPath, schemaJson)
    .pipe(
      Effect.mapError((cause) =>
        syncError(input.options, "Failed to write Work Hub schema.", cause),
      ),
    );
  const launchArgs = resolveCodexLaunchArgs(input.config.launchArgs, input.environment);
  const mcpOverrides = input.options.availableMcps.flatMap(({ name }) => [
    "--config",
    `${codexMcpKey(name)}=${name === input.request.mcpName ? "true" : "false"}`,
  ]);
  const resolved = yield* resolveSpawnCommand(
    input.config.binaryPath || "codex",
    [
      "exec",
      ...codexExecLaunchArgs(launchArgs),
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      ...mcpOverrides,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "-",
    ],
    { env: input.environment },
  ).pipe(
    Effect.mapError((cause) => syncError(input.options, "Failed to resolve Codex CLI.", cause)),
  );
  const result = yield* spawnAndCollect(
    input.config.binaryPath || "codex",
    ChildProcess.make(resolved.command, resolved.args, {
      cwd: isolatedCwd,
      env: {
        ...input.environment,
        ...(input.config.homePath ? { CODEX_HOME: expandHomePath(input.config.homePath) } : {}),
      },
      shell: resolved.shell,
      stdin: {
        stream: Stream.encodeText(Stream.make(buildCollectionPrompt(input.request, nowEpochMs))),
      },
    }),
  ).pipe(
    Effect.timeoutOption(SYNC_TIMEOUT_MS),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(syncError(input.options, "Codex Work Hub sync timed out.")),
        onSome: Effect.succeed,
      }),
    ),
    Effect.mapError((cause) =>
      isProviderDriverError(cause)
        ? cause
        : syncError(input.options, "Codex Work Hub sync failed.", cause),
    ),
  );
  if (result.code !== 0) {
    return yield* syncError(
      input.options,
      result.stderr.trim() || result.stdout.trim() || `Codex exited with code ${result.code}.`,
    );
  }
  const rawOutput = yield* fileSystem
    .readFileString(outputPath)
    .pipe(
      Effect.mapError((cause) => syncError(input.options, "Failed to read Codex output.", cause)),
    );
  const collection = yield* decodeCollectionResult(rawOutput).pipe(
    Effect.mapError((cause) =>
      syncError(input.options, "Codex returned invalid Work Hub data.", cause),
    ),
  );
  return buildAxisWorkHubCacheSnapshot({
    request: input.request,
    result: collection,
    nowEpochMs,
  });
});

export function buildClaudeWorkHubToolArgs(mcpName: string): ReadonlyArray<string> {
  // claude.ai connector tools are deferred in headless mode: they are absent from the
  // initial tool list and only become callable after a ToolSearch load, so ToolSearch
  // must stay allowed. --tools cannot be used at all — it restricts to the built-in
  // set and silently drops every MCP tool (ToolSearch included). No MCP discovery
  // round-trip either: allow both possible prefixes for the selected connector
  // (claude.ai scope and local scope) and let --permission-prompts none deny every
  // other tool. Permission rules match the server-prefix form (mcp__server), not the
  // __* glob, so pass both forms.
  const sanitizedName = mcpName.replace(/[^A-Za-z0-9_-]/gu, "_");
  const serverRules = [`mcp__${sanitizedName}`, `mcp__claude_ai_${sanitizedName}`].flatMap(
    (rule) => [rule, `${rule}__*`],
  );
  return ["--allowedTools", "Read", "ToolSearch", ...serverRules];
}

export const collectClaudeWorkHubSource = Effect.fn("collectClaudeWorkHubSource")(
  function* (input: {
    readonly request: AxisWorkHubCollectInput;
    readonly config: ClaudeSettings;
    readonly environment: NodeJS.ProcessEnv;
    readonly options: ProviderWorkHubSyncOptions;
  }) {
    const nowEpochMs = yield* Clock.currentTimeMillis;
    const fileSystem = yield* FileSystem.FileSystem;
    const isolatedCwd = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3-work-hub-claude-" })
      .pipe(
        Effect.mapError((cause) =>
          syncError(input.options, "Failed to create an isolated sync directory.", cause),
        ),
      );
    const schemaJson = yield* encodeJson(toJsonSchemaObject(AxisWorkHubCollectionResult)).pipe(
      Effect.mapError((cause) =>
        syncError(input.options, "Failed to encode Work Hub schema.", cause),
      ),
    );
    const toolArgs = buildClaudeWorkHubToolArgs(input.request.mcpName);
    const resolved = yield* resolveSpawnCommand(
      input.config.binaryPath || "claude",
      [
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        schemaJson,
        "--no-session-persistence",
        // ponytail: hardcoded model — the user's default (larger) model blows the sync
        // timeout, and haiku follows the slice checklist too inconsistently. Sonnet is
        // the middle ground. Make it configurable per source if someone needs otherwise.
        "--model",
        "sonnet",
        "--permission-mode",
        "dontAsk",
        "--permission-prompts",
        "none",
        ...toolArgs,
      ],
      { env: input.environment },
    ).pipe(
      Effect.mapError((cause) => syncError(input.options, "Failed to resolve Claude CLI.", cause)),
    );
    const result = yield* spawnAndCollect(
      input.config.binaryPath || "claude",
      ChildProcess.make(resolved.command, resolved.args, {
        cwd: isolatedCwd,
        env: input.environment,
        shell: resolved.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(buildCollectionPrompt(input.request, nowEpochMs))),
        },
      }),
    ).pipe(
      Effect.timeoutOption(SYNC_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(syncError(input.options, "Claude Work Hub sync timed out.")),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError((cause) =>
        isProviderDriverError(cause)
          ? cause
          : syncError(input.options, "Claude Work Hub sync failed.", cause),
      ),
    );
    if (result.code !== 0) {
      return yield* syncError(
        input.options,
        result.stderr.trim() || result.stdout.trim() || `Claude exited with code ${result.code}.`,
      );
    }
    const envelope = yield* decodeClaudeStructuredOutput(result.stdout).pipe(
      Effect.mapError((cause) =>
        syncError(input.options, "Claude returned invalid Work Hub data.", cause),
      ),
    );
    return buildAxisWorkHubCacheSnapshot({
      request: input.request,
      result: envelope.structured_output,
      nowEpochMs,
    });
  },
);

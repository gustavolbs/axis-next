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

const SYNC_TIMEOUT_MS = 180_000;
const MAX_CACHED_ITEMS_PER_SOURCE = 500;
const INITIAL_MESSAGE_LOOKBACK_DAYS = 14;
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
  readonly availableMcpNames: ReadonlyArray<string>;
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
    return input.collectionPolicy.assignedWorkItemsOnly && item.view === "board";
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

function buildCollectionPrompt(input: AxisWorkHubCollectInput): string {
  const messageWindow = input.previousRefreshedAt
    ? `since ${input.previousRefreshedAt}`
    : `from the last ${INITIAL_MESSAGE_LOOKBACK_DAYS} days`;
  return `You are performing a read-only Axis Work Hub sync.

Use only tools from the MCP server named ${JSON.stringify(input.mcpName)}. Never use shell, filesystem, browser, web search, built-in tools, or another MCP. Never create, update, send, delete, or acknowledge anything.

Collect only categories the MCP actually supports:
- calendar-event / calendar: events from ${input.collectionPolicy.calendarLookbackDays} days ago through ${input.collectionPolicy.calendarLookaheadDays} days ahead. Include meetingLink and location when available.
- assigned-work-item / board: only work items assigned to the authenticated user.
- direct-message / messages: only direct messages to the authenticated user ${messageWindow}.
- mention / messages: only messages mentioning the authenticated user ${messageWindow}.
- assigned-issue-comment / messages: only new comments ${messageWindow} on work items assigned to the authenticated user.

Use stable native IDs. Use null for unavailable optional values. Do not include general channel traffic, other users' tickets, historical calendar data outside the window, or guessed data. Return at most ${MAX_CACHED_ITEMS_PER_SOURCE} items and an opaque pagination cursor when the MCP provides one. Previous cursor: ${JSON.stringify(input.previousCursor)}.`;
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
  if (!input.options.availableMcpNames.includes(input.request.mcpName)) {
    return yield* syncError(input.options, `MCP '${input.request.mcpName}' was not found.`);
  }
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
  const mcpOverrides = input.options.availableMcpNames.flatMap((name) => [
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
      stdin: { stream: Stream.encodeText(Stream.make(buildCollectionPrompt(input.request))) },
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
  const nowEpochMs = yield* Clock.currentTimeMillis;
  return buildAxisWorkHubCacheSnapshot({
    request: input.request,
    result: collection,
    nowEpochMs,
  });
});

export const collectClaudeWorkHubSource = Effect.fn("collectClaudeWorkHubSource")(
  function* (input: {
    readonly request: AxisWorkHubCollectInput;
    readonly config: ClaudeSettings;
    readonly environment: NodeJS.ProcessEnv;
    readonly options: ProviderWorkHubSyncOptions;
  }) {
    if (!input.options.availableMcpNames.includes(input.request.mcpName)) {
      return yield* syncError(input.options, `MCP '${input.request.mcpName}' was not found.`);
    }
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
    const selectedToolPattern = `mcp__${input.request.mcpName}__*`;
    const excludedToolPatterns = input.options.availableMcpNames
      .filter((name) => name !== input.request.mcpName)
      .map((name) => `mcp__${name}__*`);
    const resolved = yield* resolveSpawnCommand(
      input.config.binaryPath || "claude",
      [
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        schemaJson,
        "--no-session-persistence",
        "--permission-mode",
        "dontAsk",
        "--permission-prompts",
        "none",
        "--tools",
        "",
        "--allowedTools",
        selectedToolPattern,
        ...(excludedToolPatterns.length > 0 ? ["--disallowedTools", ...excludedToolPatterns] : []),
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
        stdin: { stream: Stream.encodeText(Stream.make(buildCollectionPrompt(input.request))) },
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
    const nowEpochMs = yield* Clock.currentTimeMillis;
    return buildAxisWorkHubCacheSnapshot({
      request: input.request,
      result: envelope.structured_output,
      nowEpochMs,
    });
  },
);

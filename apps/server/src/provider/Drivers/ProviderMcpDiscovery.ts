// @effect-diagnostics nodeBuiltinImport:off - MCP discovery reads native JSON config files in cwd and home.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ProviderMcpServer } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { spawnAndCollect } from "../providerSnapshot.ts";

class ProviderMcpDiscoveryCommandError extends Schema.TaggedErrorClass<ProviderMcpDiscoveryCommandError>()(
  "ProviderMcpDiscoveryCommandError",
  { message: Schema.String },
) {}

type CodexMcpListEntry = {
  readonly name?: unknown;
  readonly enabled?: unknown;
  readonly disabled_reason?: unknown;
  readonly auth_status?: unknown;
  readonly transport?: unknown;
};

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function safeTarget(value: unknown): string | undefined {
  const target = nonEmpty(value);
  if (!target) return undefined;
  try {
    const url = new URL(target);
    return `${url.origin}${url.pathname}`;
  } catch {
    return target.split(/\s+/u)[0];
  }
}

export function parseCodexMcpList(stdout: string): ReadonlyArray<ProviderMcpServer> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(decoded)) return [];

  return decoded.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const entry = value as CodexMcpListEntry;
    const name = nonEmpty(entry.name);
    if (!name) return [];
    const enabled = entry.enabled !== false;
    const transport =
      entry.transport && typeof entry.transport === "object"
        ? (entry.transport as Record<string, unknown>)
        : undefined;
    const transportType = nonEmpty(transport?.type);
    const target = safeTarget(transport?.url) ?? safeTarget(transport?.command);
    const authStatus = nonEmpty(entry.auth_status);
    return [
      {
        name,
        enabled,
        status: enabled
          ? authStatus === "not_authenticated"
            ? "authentication-required"
            : "configured"
          : "disabled",
        ...(transportType ? { transport: transportType } : {}),
        ...(target ? { target } : {}),
        ...(nonEmpty(entry.disabled_reason) ? { detail: nonEmpty(entry.disabled_reason) } : {}),
      } satisfies ProviderMcpServer,
    ];
  });
}

const CLAUDE_STATUS =
  / - (✔ Connected|! Needs authentication|✘ Failed to connect|⏸ Pending approval)(?:\s*[—-]\s*(.*))?$/u;

export function parseClaudeMcpList(stdout: string): ReadonlyArray<ProviderMcpServer> {
  return stdout.split(/\r?\n/u).flatMap((rawLine) => {
    const line = rawLine.trim();
    const statusMatch = CLAUDE_STATUS.exec(line);
    if (!statusMatch) return [];
    const prefix = line.slice(0, statusMatch.index);
    const separator = prefix.indexOf(": ");
    if (separator <= 0) return [];
    const rawName = prefix.slice(0, separator);
    const target = safeTarget(prefix.slice(separator + 2));
    const claudeAi = rawName.startsWith("claude.ai ");
    const name = nonEmpty(claudeAi ? rawName.slice("claude.ai ".length) : rawName);
    if (!name) return [];
    const nativeStatus = statusMatch[1];
    const status =
      nativeStatus === "✔ Connected"
        ? "connected"
        : nativeStatus === "! Needs authentication"
          ? "authentication-required"
          : nativeStatus === "⏸ Pending approval"
            ? "pending-approval"
            : "failed";
    const detail = nonEmpty(statusMatch[2]);
    return [
      {
        name,
        enabled: status !== "pending-approval",
        status,
        scope: claudeAi ? "claude.ai" : "local",
        ...(target ? { target } : {}),
        ...(detail ? { detail } : {}),
      } satisfies ProviderMcpServer,
    ];
  });
}

export const discoverProviderMcpServers = Effect.fn("discoverProviderMcpServers")(
  function* (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly parse: (stdout: string) => ReadonlyArray<ProviderMcpServer>;
  }) {
    const resolved = yield* resolveSpawnCommand(input.binaryPath, input.args, {
      env: input.environment,
    });
    const result = yield* spawnAndCollect(
      input.binaryPath,
      ChildProcess.make(resolved.command, resolved.args, {
        cwd: input.cwd,
        env: input.environment,
        extendEnv: true,
        shell: resolved.shell,
      }),
    );
    if (result.code !== 0) {
      return yield* new ProviderMcpDiscoveryCommandError({
        message: result.stderr.trim() || `MCP discovery exited with code ${result.code}.`,
      });
    }
    return input.parse(result.stdout);
  },
);

/**
 * Parse OpenCode MCP servers from its native JSON config files. OpenCode
 * reads `~/.config/opencode/opencode.json` (user) and `<cwd>/opencode.json`
 * (project); both carry an `mcp` map whose entries are either
 * `{ type: "local", command: [...], environment, enabled? }` or
 * `{ type: "remote", url, enabled?, headers? }`. Disabled entries are kept so
 * the picker can show them as off.
 */
export function parseOpenCodeMcpConfig(raw: string): ReadonlyArray<ProviderMcpServer> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof decoded !== "object" || decoded === null) return [];
  const mcp = (decoded as Record<string, unknown>).mcp;
  if (typeof mcp !== "object" || mcp === null) return [];

  return Object.entries(mcp as Record<string, unknown>).flatMap<
    ProviderMcpServer,
    [string, unknown]
  >(([name, entry]) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type.trim() : "";
    const enabled = record.enabled !== false;
    if (type === "remote") {
      const url = typeof record.url === "string" ? record.url.trim() : "";
      return [
        {
          name,
          enabled,
          status: enabled ? "configured" : "disabled",
          transport: "http",
          target: safeTarget(url) ?? undefined,
        } satisfies ProviderMcpServer,
      ];
    }
    const command = Array.isArray(record.command)
      ? record.command
          .filter((part): part is string => typeof part === "string")
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
      : [];
    const target = command.length > 0 ? command.join(" ") : undefined;
    return [
      {
        name,
        enabled,
        status: enabled ? "configured" : "disabled",
        transport: "stdio",
        ...(target ? { target } : {}),
      } satisfies ProviderMcpServer,
    ];
  });
}

/** Strip ANSI color codes that the opencode CLI emits on its mcp list output. */
const ANSI_ESCAPE = String.fromCharCode(27);
function stripAnsi(value: string): string {
  // CSI sequences: ESC [ … letter. Composed from String.fromCharCode so the
  // regex literal carries no raw control characters.
  return value.replace(new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*[A-Za-z]`, "gu"), "");
}

/**
 * Fallback parser for `opencode mcp list`. The CLI prints a framed TUI with one
 * line per server carrying its name and connection status. We split on the
 * framing glyphs and keep the readable entries only.
 */
export function parseOpenCodeMcpList(stdout: string): ReadonlyArray<ProviderMcpServer> {
  const cleaned = stripAnsi(stdout);
  const STATUS = /\b(connected|disabled|failed|connecting|needs auth)\b/iu;
  return cleaned
    .split(/\r?\n/u)
    .map((line) => line.replace(/^[\s│┌└┐┘├┤─▲►▼◀●]+/gu, "").trim())
    .filter(
      (line) => line.length > 0 && !line.startsWith("MCP Servers") && !line.startsWith("Add "),
    )
    .flatMap((line) => {
      const match = STATUS.exec(line);
      if (!match) return [];
      const rawName = line.slice(0, match.index).trim();
      const name = rawName.split(/\s+/u)[0]?.trim();
      if (!name) return [];
      const nativeStatus = match[0].toLowerCase();
      const status =
        nativeStatus === "connected"
          ? "connected"
          : nativeStatus === "needs auth"
            ? "authentication-required"
            : nativeStatus === "failed"
              ? "failed"
              : "configured";
      return [
        {
          name,
          enabled: nativeStatus !== "disabled",
          status,
          scope: "local",
        } satisfies ProviderMcpServer,
      ];
    });
}

/**
 * Discover OpenCode MCP servers without spawning the CLI. OpenCode stores its
 * config in two JSON files: `<cwd>/opencode.json` (project) and
 * `~/.config/opencode/opencode.json` (user). Both hold an `mcp` map; project
 * wins on name conflicts, matching OpenCode's own precedence. Falls back to
 * the empty list when neither file exists or neither parses.
 */
export function discoverOpenCodeMcpServers(input: {
  readonly cwd: string;
}): ReadonlyArray<ProviderMcpServer> {
  const candidates = [
    NodePath.join(input.cwd, "opencode.json"),
    NodePath.join(input.cwd, ".opencode", "opencode.json"),
    NodePath.join(NodeOS.homedir(), ".config", "opencode", "opencode.json"),
  ];
  const serversByName = new Map<string, ProviderMcpServer>();
  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = NodeFS.readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    for (const server of parseOpenCodeMcpConfig(raw)) {
      if (!serversByName.has(server.name)) {
        serversByName.set(server.name, { ...server, scope: "project" });
      }
    }
  }
  return [...serversByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

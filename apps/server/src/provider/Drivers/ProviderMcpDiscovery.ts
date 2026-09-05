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

/**
 * Optional adapter for an externally installed Caveman Engine executable.
 *
 * The BSL-licensed engine is deliberately not bundled with Axis. The adapter
 * only owns process invocation; TokenEfficiencyEngine still owns fail-open,
 * net-negative, and recovery invariants. `recordOnly` is the safe initial
 * rollout: an installation can measure real output without changing a Turn.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - the optional executable is an isolated adapter boundary.
import * as NodeChildProcess from "node:child_process";

import { TokenEfficiencyEngineId } from "@t3tools/contracts";

import type { TokenEfficiencyTransform } from "./TokenEfficiencyEngine.ts";

export const CAVEMAN_ENGINE_ID = TokenEfficiencyEngineId.make("caveman");

export interface CavemanEngineAdapterOptions {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly spawnProcess?: typeof NodeChildProcess.spawn;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Caveman's stdin/stdout CLI contract is plain text. stderr is intentionally
 * ignored so an engine cannot leak input or diagnostics into provider logs.
 */
export const makeCavemanTransform = (
  options: CavemanEngineAdapterOptions,
): TokenEfficiencyTransform => {
  const spawnProcess = options.spawnProcess ?? NodeChildProcess.spawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return (text) =>
    new Promise<string>((resolve, reject) => {
      let child: ReturnType<typeof NodeChildProcess.spawn>;
      try {
        child = spawnProcess(options.command, [...(options.args ?? ["compress"])], {
          cwd: options.cwd,
          stdio: ["pipe", "pipe", "ignore"],
          shell: false,
        });
      } catch (error) {
        reject(error);
        return;
      }

      const chunks: Array<Buffer> = [];
      let outputBytes = 0;
      let settled = false;
      // @effect-diagnostics-next-line globalTimers:off - this adapter owns a bounded child-process timeout.
      const timeout = setTimeout(() => {
        child.kill();
        finish(new Error("external token-efficiency engine timed out"));
      }, timeoutMs);

      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error !== undefined) reject(error);
        else resolve(Buffer.concat(chunks).toString("utf8"));
      };

      child.stdout!.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.byteLength;
        if (outputBytes > maxOutputBytes) {
          child.kill();
          finish(new Error("external token-efficiency engine output exceeded the limit"));
          return;
        }
        chunks.push(buffer);
      });
      child.once("error", finish);
      child.once("close", (code) => {
        if (code === 0) finish();
        else finish(new Error("external token-efficiency engine exited unsuccessfully"));
      });

      child.stdin!.end(text);
    });
};

import { describe, expect, it } from "vite-plus/test";

import { makeCavemanTransform } from "./CavemanEngineAdapter.ts";

describe("makeCavemanTransform", () => {
  it("invokes an external command with stdin and returns stdout", async () => {
    const transform = makeCavemanTransform({
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.on('data', chunk => process.stdout.write(chunk.toString().toUpperCase()))",
      ],
    });
    await expect(transform("hello")).resolves.toBe("HELLO");
  });

  it("fails closed when the external command exits unsuccessfully", async () => {
    const transform = makeCavemanTransform({
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
    });
    await expect(transform("secret input")).rejects.toThrow();
  });
});

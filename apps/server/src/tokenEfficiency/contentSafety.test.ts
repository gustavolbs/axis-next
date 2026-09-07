import { describe, expect, it } from "vite-plus/test";

import { classifyLine, containsSecret, isCompressiblePayloadKind } from "./contentSafety.ts";

describe("payload kinds", () => {
  it("treats anything the caller could not classify as protected", () => {
    expect(isCompressiblePayloadKind("unknown")).toBe(false);
    expect(isCompressiblePayloadKind("terminal-output")).toBe(true);
  });
});

describe("classifyLine", () => {
  // Each entry is a line that must survive byte-for-byte. A regression here
  // does not fail loudly at runtime — it produces plausible, wrong output —
  // so the table is the real specification of what the compressor may touch.
  const protectedLines: ReadonlyArray<readonly [string, string]> = [
    ["diff", "+  const timeout = 30;"],
    ["diff", "@@ -1,4 +1,6 @@"],
    ["diff", "diff --git a/src/main.ts b/src/main.ts"],
    ["command", "$ rm -rf ./build"],
    ["path-or-url", "https://api.example.com/v1/models"],
    ["path-or-url", "  reading ./src/server/main.ts"],
    ["structured-data", '  "maxRetries": 3,'],
    ["structured-data", "  }"],
    ["error", "Error: connection refused"],
    ["error", "  the request failed after 3 attempts"],
    ["stack-frame", "    at Object.<anonymous> (/app/index.js:12:9)"],
    ["identifier", "commit 7570472d829549e33056927476576445f76052bb"],
    ["identifier", "port 58231 already in use"],
    ["secret", "ANTHROPIC_AUTH_TOKEN=sk-routemux-abcdefgh"],
    ["secret", "authorization: Bearer abc123"],
    ["secret", "  password: hunter2"],
  ];

  for (const [why, line] of protectedLines) {
    it(`protects ${why}: ${line.trim().slice(0, 40)}`, () => {
      expect(classifyLine(line)).toMatchObject({ protected: true });
    });
  }

  it("leaves ordinary prose and blank lines compressible", () => {
    expect(classifyLine("Installing dependencies")).toEqual({ protected: false, why: undefined });
    expect(classifyLine("   ")).toEqual({ protected: false, why: undefined });
  });
});

describe("containsSecret", () => {
  it("finds a credential anywhere in a payload, not just on the first line", () => {
    expect(containsSecret("all good\nnothing here\napi_key = abcdef\nbye")).toBe(true);
    expect(containsSecret("all good\nnothing here\nbye")).toBe(false);
  });
});

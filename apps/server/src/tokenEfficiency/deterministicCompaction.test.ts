import { describe, expect, it } from "vite-plus/test";

import { compactDeterministically, estimateTokens } from "./deterministicCompaction.ts";

const lines = (...values: ReadonlyArray<string>) => values.join("\n");

describe("compactDeterministically", () => {
  const NOISE = "  npm warn deprecated transitive dependency, see the log for details";

  it("collapses a run of identical lines and says how many it dropped", () => {
    const result = compactDeterministically(lines("start", NOISE, NOISE, NOISE, NOISE, "done"));
    expect(result.text).toBe(
      lines("start", NOISE, "… previous line repeated 3 more times", "done"),
    );
    expect(result.removedLines).toBe(2);
  });

  it("keeps a short run intact rather than trading clarity for two tokens", () => {
    const text = lines("start", NOISE, NOISE, "done");
    expect(compactDeterministically(text)).toEqual({ text, removedLines: 0 });
  });

  // The marker has a fixed cost of ~45 characters. Four repetitions of a
  // seven-character line cost less than announcing that they were removed, so
  // collapsing them would make the payload bigger — and the engine would then
  // discard the whole compaction, losing every real saving alongside it.
  it("leaves a run alone when the marker would cost more than the run", () => {
    const text = lines("start", "waiting", "waiting", "waiting", "waiting", "done");
    expect(compactDeterministically(text)).toEqual({ text, removedLines: 0 });
  });

  it("never collapses repeated protected lines", () => {
    // Repetition *is* the signal here: four identical frames means a loop.
    const text = lines(
      "    at retry (/app/retry.js:8:3)",
      "    at retry (/app/retry.js:8:3)",
      "    at retry (/app/retry.js:8:3)",
      "    at retry (/app/retry.js:8:3)",
    );
    expect(compactDeterministically(text).text).toBe(text);
  });

  it("collapses runs of blank lines", () => {
    expect(compactDeterministically(lines("a", "", "", "", "b")).text).toBe(lines("a", "", "b"));
  });

  it("elides the middle of very long output and reports the count", () => {
    const long = Array.from(
      { length: 500 },
      (_, index) => `line ${String.fromCharCode(97 + (index % 26))}`,
    );
    const result = compactDeterministically(long.join("\n"), {
      repeatThreshold: 1000,
      maxConsecutiveBlankLines: 1,
      maxLines: 100,
      edgeLines: 10,
    });
    expect(result.text.split("\n")).toHaveLength(21);
    expect(result.text).toContain("… 480 lines omitted from the middle of this output");
  });

  it("refuses to elide a middle that hides an error", () => {
    // The one line worth reading is often buried in the middle; deciding it
    // is not worth reading is exactly the judgement this layer must not make.
    const long = [
      ...Array.from({ length: 200 }, () => "progress"),
      "Error: disk full",
      ...Array.from({ length: 200 }, () => "progress"),
    ];
    const result = compactDeterministically(long.join("\n"), {
      repeatThreshold: 1000,
      maxConsecutiveBlankLines: 1,
      maxLines: 100,
      edgeLines: 10,
    });
    expect(result.text).toContain("Error: disk full");
    expect(result.text.split("\n")).toHaveLength(401);
  });

  it("returns the input unchanged when there is nothing to remove", () => {
    const text = lines("alpha", "beta", "gamma");
    expect(compactDeterministically(text)).toEqual({ text, removedLines: 0 });
  });

  it("is deterministic, which is what makes an A/B against it meaningful", () => {
    const text = lines(NOISE, NOISE, NOISE, NOISE, "b", "", "", "c");
    expect(compactDeterministically(text)).toEqual(compactDeterministically(text));
  });
});

describe("estimateTokens", () => {
  it("grows with length and is never negative", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

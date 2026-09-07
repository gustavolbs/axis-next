/**
 * Shape-aware compaction — the first engine, and the one to beat.
 *
 * It removes only redundancy a reader would not miss: runs of identical
 * lines, runs of blank lines, and the middle of very long homogeneous output.
 * Every removal leaves an explicit marker saying what was dropped, so the
 * model reads a truthful summary rather than silently shortened output.
 *
 * There is no natural-language rewriting here on purpose. The roadmap order
 * is deliberate: prove the deterministic, explainable savings first, because
 * a lossy engine that also happens to collapse duplicate lines will otherwise
 * take credit for savings that cost nothing.
 *
 * @module tokenEfficiency/deterministicCompaction
 */
import { classifyLine } from "./contentSafety.ts";

export interface CompactionOptions {
  /** Identical lines repeated at least this many times collapse. */
  readonly repeatThreshold: number;
  /** Consecutive blank lines above this count collapse to this count. */
  readonly maxConsecutiveBlankLines: number;
  /**
   * Above this many lines, the middle of an unprotected run is elided. Zero
   * disables eliding entirely.
   */
  readonly maxLines: number;
  /** Lines kept at each end when eliding the middle. */
  readonly edgeLines: number;
}

export const DEFAULT_COMPACTION_OPTIONS: CompactionOptions = {
  repeatThreshold: 3,
  maxConsecutiveBlankLines: 1,
  maxLines: 400,
  edgeLines: 80,
};

export interface CompactionResult {
  readonly text: string;
  /** Lines removed, for reporting a saving that can be checked by hand. */
  readonly removedLines: number;
}

const repeatMarker = (runLength: number) => `… previous line repeated ${runLength - 1} more times`;

/**
 * Collapse runs of identical lines and runs of blank lines.
 *
 * A run is only collapsed when its line is unprotected: repeated identical
 * stack frames or repeated identical paths stay, because their repetition is
 * often the signal being read.
 */
function collapseRuns(lines: ReadonlyArray<string>, options: CompactionOptions): Array<string> {
  const out: Array<string> = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    let runLength = 1;
    while (index + runLength < lines.length && lines[index + runLength] === line) runLength += 1;

    const isBlank = line.trim().length === 0;
    if (isBlank) {
      const keep = Math.min(runLength, options.maxConsecutiveBlankLines);
      for (let i = 0; i < keep; i += 1) out.push(line);
    } else if (runLength >= options.repeatThreshold && !classifyLine(line).protected) {
      const marker = repeatMarker(runLength);
      // The marker has a fixed cost. Collapsing four short lines can spend
      // more characters than it saves, so a run only collapses when it
      // actually shrinks — otherwise the engine would discard the whole
      // payload as net-negative and every real saving in it with it.
      if (marker.length < (line.length + 1) * (runLength - 1)) {
        out.push(line, marker);
      } else {
        for (let i = 0; i < runLength; i += 1) out.push(line);
      }
    } else {
      for (let i = 0; i < runLength; i += 1) out.push(line);
    }
    index += runLength;
  }
  return out;
}

/**
 * Elide the middle of output that is too long to be worth sending whole.
 *
 * Declines whenever the region that would be dropped contains anything
 * protected — an error buried in the middle of 10,000 log lines is exactly
 * the line worth keeping, and it is not this module's job to decide it is
 * not.
 */
function elideMiddle(lines: ReadonlyArray<string>, options: CompactionOptions): Array<string> {
  if (options.maxLines <= 0 || lines.length <= options.maxLines) return [...lines];
  const head = lines.slice(0, options.edgeLines);
  const tail = lines.slice(lines.length - options.edgeLines);
  const middle = lines.slice(options.edgeLines, lines.length - options.edgeLines);
  if (middle.some((line) => classifyLine(line).protected)) return [...lines];
  return [...head, `… ${middle.length} lines omitted from the middle of this output`, ...tail];
}

/**
 * Compact one payload. Pure and deterministic: the same input always yields
 * the same output, which is what makes an A/B against it meaningful.
 */
export function compactDeterministically(
  text: string,
  options: CompactionOptions = DEFAULT_COMPACTION_OPTIONS,
): CompactionResult {
  const lines = text.split("\n");
  const compacted = elideMiddle(collapseRuns(lines, options), options);
  const compactedText = compacted.join("\n");
  if (compactedText.length >= text.length) {
    return { text, removedLines: 0 };
  }
  return { text: compactedText, removedLines: lines.length - compacted.length };
}

/**
 * Rough token count. Deliberately an estimate and named as one: it decides
 * whether a transform was worth applying, never what anyone is billed. The
 * billed figures come from the usage layer after the turn, and mixing the two
 * would let an engine report savings it did not produce.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

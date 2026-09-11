import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AxisOnboardingApplyInput,
  AxisOnboardingCandidateRule,
  AxisOnboardingCancelInput,
  AxisOnboardingRetryInput,
  AxisOnboardingRun,
  AxisOnboardingSource,
} from "./axisOnboarding.ts";

const decodeRun = Schema.decodeUnknownSync(AxisOnboardingRun);
const decodeSource = Schema.decodeUnknownSync(AxisOnboardingSource);
const decodeApply = Schema.decodeUnknownSync(AxisOnboardingApplyInput);
const decodeCandidate = Schema.decodeUnknownSync(AxisOnboardingCandidateRule);
const decodeCancel = Schema.decodeUnknownSync(AxisOnboardingCancelInput);
const decodeRetry = Schema.decodeUnknownSync(AxisOnboardingRetryInput);

const scope = {
  contextId: "company_a",
  project: { environmentId: "laptop", projectId: "workhub" },
};

describe("Axis onboarding contracts", () => {
  it("links a run to canonical T3 execution and keeps candidates separate", () => {
    const run = decodeRun({
      id: "onboarding-1",
      scope,
      execution: { threadId: "thread-1", turnId: "turn-1", commandId: "command-1" },
      status: "completed",
      sources: [],
      digests: [],
      facts: [],
      candidateRules: [],
      conflicts: [],
      decisions: [],
      error: null,
      startedAt: "2026-09-09T10:00:00.000Z",
      finishedAt: "2026-09-09T10:01:00.000Z",
    });

    expect(run.execution).toEqual({ threadId: "thread-1", turnId: "turn-1", commandId: "command-1" });
    expect(run).toHaveProperty("candidateRules");
    expect(run).not.toHaveProperty("profile");
  });

  it("represents cancellation, failure, and completion as distinct terminal states", () => {
    const base = {
      id: "onboarding-1",
      scope,
      execution: { threadId: "thread-1", turnId: "turn-1", commandId: "command-1" },
      sources: [],
      digests: [],
      facts: [],
      candidateRules: [],
      conflicts: [],
      decisions: [],
      startedAt: "2026-09-09T10:00:00.000Z",
    };

    expect(decodeRun({ ...base, status: "running", error: null, finishedAt: null }).status).toBe("running");
    expect(decodeRun({ ...base, status: "cancelled", error: null, finishedAt: "2026-09-09T10:01:00.000Z" }).status).toBe("cancelled");
    expect(decodeRun({ ...base, status: "failed", error: "Provider stopped.", finishedAt: "2026-09-09T10:01:00.000Z" }).status).toBe("failed");
    expect(decodeRun({ ...base, status: "completed", error: null, finishedAt: "2026-09-09T10:01:00.000Z" }).status).toBe("completed");

    expect(() => decodeRun({ ...base, status: "failed", error: null, finishedAt: "2026-09-09T10:01:00.000Z" })).toThrow();
    expect(() => decodeRun({ ...base, status: "completed", error: null, finishedAt: null })).toThrow();
    expect(() => decodeRun({ ...base, status: "cancelled", error: null, finishedAt: null })).toThrow();
  });

  it("does not collapse a read failure into an absent source", () => {
    const source = decodeSource({
      id: "agents-md",
      path: "AGENTS.md",
      kind: "instruction",
      status: "failed",
      error: "Permission denied",
    });

    expect(source.status).toBe("failed");
    expect(source).not.toEqual(expect.objectContaining({ status: "absent" }));

    expect(
      decodeSource({ id: "missing", path: "CLAUDE.md", kind: "instruction", status: "absent", error: null }).status,
    ).toBe("absent");
    expect(() =>
      decodeSource({ id: "bad", path: "CLAUDE.md", kind: "instruction", status: "failed", error: null }),
    ).toThrow();
    expect(() =>
      decodeSource({ id: "bad", path: "CLAUDE.md", kind: "instruction", status: "absent", error: "Permission denied" }),
    ).toThrow();
  });

  it("keeps cancellation and retry as explicit commands tied to T3 command ids", () => {
    expect(decodeCancel({ runId: "onboarding-1", commandId: "command-cancel", reason: "User stopped the scan." })).toMatchObject({
      runId: "onboarding-1",
      commandId: "command-cancel",
    });
    expect(decodeRetry({ runId: "onboarding-1", commandId: "command-retry" })).toEqual({
      runId: "onboarding-1",
      commandId: "command-retry",
    });
  });

  it("keeps candidate rules out of the active profile and bounds candidate text", () => {
    const candidate = decodeCandidate({
      id: "rule-1",
      category: "test-policy",
      text: "Run the focused contract tests.",
      effect: "restriction",
      sourceIds: ["source-1"],
      factIds: [],
    });

    expect(candidate).not.toHaveProperty("profile");
    expect(candidate).not.toHaveProperty("active");
    expect(() => decodeCandidate({ ...candidate, text: "x".repeat(8_001) })).toThrow();
  });

  it("requires the expected profile revision to apply decisions", () => {
    expect(() =>
      decodeApply({
        scope,
        runId: "onboarding-1",
        decisions: [],
        commandId: "command-2",
      }),
    ).toThrow();

    expect(
      decodeApply({
        scope,
        runId: "onboarding-1",
        expectedProfileRevision: 3,
        decisions: [],
        commandId: "command-2",
      }).expectedProfileRevision,
    ).toBe(3);
  });

  it("bounds onboarding collections and decision text", () => {
    expect(() =>
      decodeApply({
        scope,
        runId: "onboarding-1",
        expectedProfileRevision: 0,
        decisions: Array.from({ length: 501 }, (_, index) => ({
          id: `decision-${index}`,
          candidateRuleId: "rule-1",
          decision: "defer",
          note: null,
        })),
        commandId: "command-2",
      }),
    ).toThrow();

    expect(() =>
      decodeRun({
        id: "onboarding-1",
        scope,
        execution: { threadId: "thread-1", turnId: "turn-1", commandId: "command-1" },
        status: "completed",
        sources: Array.from({ length: 201 }, (_, index) => ({
          id: `source-${index}`,
          path: `source-${index}.md`,
          kind: "instruction",
          status: "absent",
          error: null,
        })),
        digests: [],
        facts: [],
        candidateRules: [],
        conflicts: [],
        decisions: [],
        error: null,
        startedAt: "2026-09-09T10:00:00.000Z",
        finishedAt: "2026-09-09T10:01:00.000Z",
      }),
    ).toThrow();
  });
});

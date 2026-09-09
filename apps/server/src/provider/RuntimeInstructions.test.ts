import * as NodeAssert from "node:assert/strict";

import {
  ProviderInstanceId,
  type TokenEfficiencyConciseOutputProfile,
  type TokenEfficiencySettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildRuntimeInstructions,
  buildStableRuntimePromptPrefix,
  resolveConciseOutputProfile,
} from "./RuntimeInstructions.ts";

const enabledProfile: TokenEfficiencyConciseOutputProfile = {
  enabled: true,
  maxSentences: 3,
  maxBullets: 2,
};

describe("buildRuntimeInstructions", () => {
  it.each(["Codex", "Claude Code", "Cursor", "Grok", "OpenCode", "Antigravity"])(
    "identifies the %s harness and describes media embedding",
    (harness) => {
      const instructions = buildRuntimeInstructions({ harness });
      expect(instructions).toContain(`running in T3 Code through the ${harness} harness.`);
      expect(instructions).toContain("embed images and videos");
      expect(instructions).toContain("Markdown with absolute file paths");
      expect(instructions).not.toContain("undefined");
    },
  );

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("Current turn settings, as custom model with high reasoning effort.");
  });

  it("keeps the provider-cache prefix independent from turn settings", () => {
    const prefix = buildStableRuntimePromptPrefix("Codex");
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "custom-model",
        reasoningEffort: "high",
        conciseOutputProfile: enabledProfile,
      }),
    ).toContain(prefix);
    expect(buildStableRuntimePromptPrefix("Codex")).toBe(prefix);
    expect(buildStableRuntimePromptPrefix("Codex")).not.toContain("custom-model");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });

  it("keeps the default runtime instruction unchanged when concise output is disabled", () => {
    const withoutProfile = buildRuntimeInstructions({ harness: "Cursor" });
    const disabled = buildRuntimeInstructions({
      harness: "Cursor",
      conciseOutputProfile: { ...enabledProfile, enabled: false },
    });

    NodeAssert.strictEqual(disabled, withoutProfile);
    NodeAssert.doesNotMatch(disabled, /at most/);
  });

  it("appends provider-owned limits only for an enabled profile", () => {
    const instructions = buildRuntimeInstructions({
      harness: "OpenCode",
      model: "provider/model",
      conciseOutputProfile: enabledProfile,
    });

    NodeAssert.match(instructions, /<runtime_info>.*OpenCode.*<\/runtime_info>/);
    NodeAssert.match(instructions, /Respond in your normal provider-owned voice/);
    NodeAssert.match(instructions, /at most 3 sentences/);
    NodeAssert.match(instructions, /at most 2 bullet points/);
  });

  it("prefers an instance profile over the global profile", () => {
    const instanceId = ProviderInstanceId.make("cursor-primary");
    const globalProfile = { ...enabledProfile, maxSentences: 8 };
    const settings: TokenEfficiencySettings = {
      conciseOutput: globalProfile,
      byInstance: {
        [instanceId]: { conciseOutput: enabledProfile },
      },
    };

    NodeAssert.deepStrictEqual(resolveConciseOutputProfile(settings, instanceId), enabledProfile);
    NodeAssert.deepStrictEqual(resolveConciseOutputProfile(settings, undefined), globalProfile);
  });
});

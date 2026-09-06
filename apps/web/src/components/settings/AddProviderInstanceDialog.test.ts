import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  apiKeyEnvironmentVariableForDriver,
  buildApiKeyProviderInstance,
  resolveWizardNavigation,
} from "./AddProviderInstanceDialog.logic";

describe("resolveWizardNavigation", () => {
  const invalidId = { instanceIdError: "Instance ID is required." };
  const validId = { instanceIdError: null };

  it("allows moving from Driver to Identity before the instance id is valid", () => {
    expect(resolveWizardNavigation(0, 1, 3, invalidId)).toEqual({ kind: "navigate", step: 1 });
  });

  it("blocks Next from Identity to Config while the instance id is invalid", () => {
    expect(resolveWizardNavigation(1, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("stops a direct Driver-to-Config skip at Identity and surfaces its error", () => {
    expect(resolveWizardNavigation(0, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("allows advancing and skipping forward once the instance id is valid", () => {
    expect(resolveWizardNavigation(1, 2, 3, validId)).toEqual({ kind: "navigate", step: 2 });
    expect(resolveWizardNavigation(0, 2, 3, validId)).toEqual({ kind: "navigate", step: 2 });
  });

  it("always preserves backward Driver and Identity navigation", () => {
    expect(resolveWizardNavigation(2, 1, 3, invalidId)).toEqual({ kind: "navigate", step: 1 });
    expect(resolveWizardNavigation(2, 0, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
    expect(resolveWizardNavigation(1, 0, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
  });

  it("clamps requested steps to the wizard bounds", () => {
    expect(resolveWizardNavigation(2, 8, 3, validId)).toEqual({ kind: "navigate", step: 2 });
    expect(resolveWizardNavigation(0, -1, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
  });
});

describe("API-key provider preset", () => {
  it("creates an isolated and secret-backed Codex instance", () => {
    const instance = buildApiKeyProviderInstance({
      instanceId: ProviderInstanceId.make("codex_api_fallback"),
      driver: ProviderDriverKind.make("codex"),
      displayName: "OpenAI API fallback",
      apiKey: "  sk-test  ",
      config: { launchArgs: "--quiet" },
    });

    expect(instance).toMatchObject({
      driver: "codex",
      displayName: "OpenAI API fallback",
      credentialSource: "api-key",
      environment: [{ name: "OPENAI_API_KEY", value: "sk-test", sensitive: true }],
      config: {
        launchArgs: "--quiet",
        shadowHomePath: "~/.t3/provider-homes/codex_api_fallback",
      },
    });
  });

  it("uses an isolated Claude config home and rejects unsupported presets", () => {
    expect(
      buildApiKeyProviderInstance({
        instanceId: ProviderInstanceId.make("claude_api_fallback"),
        driver: ProviderDriverKind.make("claudeAgent"),
        apiKey: "anthropic-test",
        config: {},
      }),
    ).toMatchObject({
      credentialSource: "api-key",
      environment: [{ name: "ANTHROPIC_API_KEY", sensitive: true }],
      config: { homePath: "~/.t3/provider-homes/claude_api_fallback" },
    });
    expect(apiKeyEnvironmentVariableForDriver(ProviderDriverKind.make("cursor"))).toBeNull();
    expect(() =>
      buildApiKeyProviderInstance({
        instanceId: ProviderInstanceId.make("cursor_api_fallback"),
        driver: ProviderDriverKind.make("cursor"),
        apiKey: "secret",
        config: {},
      }),
    ).toThrow(/does not support/u);
    expect(() =>
      buildApiKeyProviderInstance({
        instanceId: ProviderInstanceId.make("codex_empty_api"),
        driver: ProviderDriverKind.make("codex"),
        apiKey: "   ",
        config: {},
      }),
    ).toThrow(/API key is required/u);
  });

  it("keeps an explicitly configured isolated home", () => {
    expect(
      buildApiKeyProviderInstance({
        instanceId: ProviderInstanceId.make("codex_api_custom"),
        driver: ProviderDriverKind.make("codex"),
        apiKey: "sk-test",
        config: { homePath: "~/.codex", shadowHomePath: " ~/.codex-api " },
      }).config,
    ).toMatchObject({ homePath: "~/.codex", shadowHomePath: "~/.codex-api" });
    expect(
      buildApiKeyProviderInstance({
        instanceId: ProviderInstanceId.make("claude_api_custom"),
        driver: ProviderDriverKind.make("claudeAgent"),
        apiKey: "anthropic-test",
        config: { homePath: " ~/.claude-api " },
      }).config,
    ).toMatchObject({ homePath: "~/.claude-api" });
  });
});

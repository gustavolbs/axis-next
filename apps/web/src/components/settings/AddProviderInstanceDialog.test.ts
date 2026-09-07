import { describe, expect, it } from "vite-plus/test";

import {
  getProviderGateway,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderGatewayDefinition,
} from "@t3tools/contracts";

import {
  apiKeyEnvironmentVariableForDriver,
  buildApiKeyProviderInstance,
  buildGatewayProviderInstance,
  parseProviderSelection,
  providerSelectionValue,
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

describe("gateway provider preset", () => {
  const routemux = getProviderGateway("routemux") as ProviderGatewayDefinition;

  it("builds an isolated, API-billed RouteMux instance on the Claude driver", () => {
    const instance = buildGatewayProviderInstance({
      instanceId: ProviderInstanceId.make("routemux_fallback"),
      gateway: routemux,
      displayName: "RouteMux",
      apiKey: "  sk-routemux-test  ",
      config: { launchArgs: "--quiet" },
    });

    expect(instance).toMatchObject({
      driver: "claudeAgent",
      gateway: "routemux",
      credentialSource: "api-key",
      environment: [
        { name: "ANTHROPIC_AUTH_TOKEN", value: "sk-routemux-test", sensitive: true },
        { name: "ANTHROPIC_BASE_URL", value: "https://api.routemux.com", sensitive: false },
        // Blanked so an ambient Anthropic key cannot outrank the gateway token.
        { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
      ],
      config: {
        launchArgs: "--quiet",
        homePath: "~/.t3/provider-homes/routemux_fallback",
      },
    });
    // The key must never ride along as a non-sensitive variable.
    expect(
      instance.environment?.filter((variable) => variable.value.includes("sk-routemux-test")),
    ).toEqual([{ name: "ANTHROPIC_AUTH_TOKEN", value: "sk-routemux-test", sensitive: true }]);
  });

  it("pins no model list, leaving the catalog to live discovery", () => {
    const config = buildGatewayProviderInstance({
      instanceId: ProviderInstanceId.make("routemux_seeded"),
      gateway: routemux,
      apiKey: "sk-test",
      config: {},
    }).config as Record<string, unknown>;
    expect(config.customModels).toBeUndefined();

    // A list the user curated by hand still round-trips untouched.
    const curated = buildGatewayProviderInstance({
      instanceId: ProviderInstanceId.make("routemux_curated"),
      gateway: routemux,
      apiKey: "sk-test",
      config: { customModels: [{ slug: "openai/gpt-5.4-mini" }] },
    }).config as { readonly customModels: ReadonlyArray<{ readonly slug: string }> };
    expect(curated.customModels).toEqual([{ slug: "openai/gpt-5.4-mini" }]);
  });

  it("requires a key and keeps an explicitly configured home", () => {
    expect(() =>
      buildGatewayProviderInstance({
        instanceId: ProviderInstanceId.make("routemux_empty"),
        gateway: routemux,
        apiKey: "   ",
        config: {},
      }),
    ).toThrow(/API key is required/u);
    expect(
      buildGatewayProviderInstance({
        instanceId: ProviderInstanceId.make("routemux_custom"),
        gateway: routemux,
        apiKey: "sk-test",
        config: { homePath: " ~/.routemux " },
      }).config,
    ).toMatchObject({ homePath: "~/.routemux" });
  });

  it("round-trips the driver-step selection encoding", () => {
    const value = providerSelectionValue(routemux.driver, routemux.id);
    expect(value).toBe("gateway:routemux");
    expect(parseProviderSelection(value)).toEqual({
      driver: routemux.driver,
      gateway: routemux,
    });
    // A plain driver slug is not a gateway, and neither is an unknown one.
    expect(parseProviderSelection("claudeAgent")).toBeNull();
    expect(parseProviderSelection("gateway:not-a-gateway")).toBeNull();
    expect(providerSelectionValue(ProviderDriverKind.make("claudeAgent"), null)).toBe(
      "claudeAgent",
    );
  });
});

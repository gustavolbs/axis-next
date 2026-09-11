import { describe, expect, it } from "vite-plus/test";

import {
  getProviderGateway,
  PROVIDER_GATEWAYS,
  providerGatewayCodexLaunchArgs,
  providerGatewayEnvironment,
} from "./providerGateway.ts";

describe("provider gateways", () => {
  it("resolves shipped gateways and nothing else", () => {
    expect(getProviderGateway("routemux")?.label).toBe("RouteMux");
    expect(getProviderGateway("openrouter")).toBeUndefined();
    expect(getProviderGateway(undefined)).toBeUndefined();
  });

  it("points RouteMux at the Anthropic protocol root, not the /v1 prefix", () => {
    const routemux = getProviderGateway("routemux");
    // Anthropic clients append `/v1/messages` themselves; a base URL ending in
    // `/v1` would resolve to `/v1/v1/messages` and 400 on every turn.
    expect(routemux?.baseUrl).toBe("https://api.routemux.com");
    expect(routemux?.driver).toBe("claudeAgent");
    expect(routemux?.apiKeyVariable).toBe("ANTHROPIC_AUTH_TOKEN");
  });

  it("defines a Codex/Responses RouteMux preset", () => {
    const routemux = getProviderGateway("routemux-codex");
    expect(routemux?.driver).toBe("codex");
    expect(routemux?.baseUrl).toBe("https://api.routemux.com/v1");
    expect(routemux?.apiKeyVariable).toBe("ROUTEMUX_API_KEY");
    expect(routemux?.modelsPath).toBe("/models");
    expect(routemux?.modelsQuery).toContain("protocol=openai_responses");
    expect(providerGatewayCodexLaunchArgs(routemux)).toContain(
      'model_providers.routemux.wire_api="responses"',
    );
  });

  it("defines an OpenCode/Chat RouteMux preset", () => {
    const routemux = getProviderGateway("routemux-opencode");
    expect(routemux?.driver).toBe("opencode");
    expect(routemux?.baseUrl).toBe("https://api.routemux.com/v1");
    expect(routemux?.apiKeyVariable).toBe("ROUTEMUX_API_KEY");
    expect(routemux?.modelsPath).toBe("/models");
    expect(routemux?.modelsQuery).toContain("protocol=openai_chat");
    expect(routemux?.opencode).toEqual({ providerId: "routemux", wireApi: "chat" });
  });

  it("marks only the credential variable sensitive", () => {
    for (const gateway of PROVIDER_GATEWAYS) {
      const environment = providerGatewayEnvironment(gateway, "sk-secret");
      const sensitive = environment.filter((variable) => variable.sensitive);
      expect(sensitive).toEqual([
        { name: gateway.apiKeyVariable, value: "sk-secret", sensitive: true },
      ]);
      expect(environment.some((variable) => variable.name === gateway.baseUrlVariable)).toBe(true);
      for (const name of gateway.clearVariables) {
        expect(environment).toContainEqual({ name, value: "", sensitive: false });
      }
    }
  });

  it("declares where to read the live model catalog", () => {
    // The list must never be pinned here: a gateway adds models continuously,
    // and the key's own entitlements decide what is actually callable.
    expect(getProviderGateway("routemux")?.modelsPath).toBe("/v1/models");
  });
});

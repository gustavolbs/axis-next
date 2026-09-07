import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderGatewayId } from "@t3tools/contracts";

import { ClaudeAI, RouteMuxIcon } from "../Icons";
import { resolveProviderIcon } from "./providerIconUtils";

const claudeAgent = ProviderDriverKind.make("claudeAgent");

describe("resolveProviderIcon", () => {
  it("shows the gateway mark rather than the driver it runs on", () => {
    expect(resolveProviderIcon({ driverKind: claudeAgent })).toBe(ClaudeAI);
    expect(
      resolveProviderIcon({ driverKind: claudeAgent, gateway: ProviderGatewayId.make("routemux") }),
    ).toBe(RouteMuxIcon);
  });

  it("falls back to the driver for a gateway this build does not ship", () => {
    expect(
      resolveProviderIcon({
        driverKind: claudeAgent,
        gateway: ProviderGatewayId.make("someForkGateway"),
      }),
    ).toBe(ClaudeAI);
    expect(
      resolveProviderIcon({ driverKind: ProviderDriverKind.make("unknownDriver") }),
    ).toBeNull();
  });
});

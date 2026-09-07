import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";
import {
  DETERMINISTIC_ENGINE_ID,
  resolveTokenEfficiency,
  TokenEfficiencyEngineId,
  TokenEfficiencySettings,
} from "./tokenEfficiency.ts";

const decode = Schema.decodeUnknownSync(TokenEfficiencySettings);
const routemux = ProviderInstanceId.make("routemux_personal");
const claude = ProviderInstanceId.make("claudeAgent");

describe("resolveTokenEfficiency", () => {
  // The adoption rule lives in this default: nothing compresses until someone
  // opts a specific instance in.
  it("is off with no settings at all", () => {
    expect(resolveTokenEfficiency(undefined, routemux)).toEqual({
      mode: "off",
      engine: DETERMINISTIC_ENGINE_ID,
    });
  });

  it("lets one instance run an A/B while the rest stay untouched", () => {
    const settings = decode({
      mode: "off",
      byInstance: { routemux_personal: { mode: "record" } },
    });
    expect(resolveTokenEfficiency(settings, routemux).mode).toBe("record");
    expect(resolveTokenEfficiency(settings, claude).mode).toBe("off");
    expect(resolveTokenEfficiency(settings, undefined).mode).toBe("off");
  });

  it("inherits the engine when an instance overrides only the mode", () => {
    const settings = decode({
      engine: "llmlingua2",
      byInstance: { routemux_personal: { mode: "compress" } },
    });
    expect(resolveTokenEfficiency(settings, routemux)).toEqual({
      mode: "compress",
      engine: TokenEfficiencyEngineId.make("llmlingua2"),
    });
  });

  it("round-trips an engine this build does not ship", () => {
    // Same rule as drivers and gateways: settings written by a build that
    // knows an engine must survive a build that does not.
    expect(decode({ engine: "someForkEngine" }).engine).toBe("someForkEngine");
  });

  it("rejects a mode outside the contract", () => {
    expect(() => decode({ mode: "aggressive" })).toThrow();
  });
});

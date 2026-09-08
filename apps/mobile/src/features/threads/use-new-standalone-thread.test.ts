import type { ServerConfig, ServerProvider } from "@t3tools/contracts";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveStandaloneThreadTarget } from "./standalone-thread-creation.logic";

function provider(input: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: "codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-07T00:00:00.000Z",
    models: [
      { slug: "fast", name: "Fast", isDefault: false },
      { slug: "best", name: "Best", isDefault: true },
    ],
    slashCommands: [],
    skills: [],
    ...input,
  } as ServerProvider;
}

function config(providers: ReadonlyArray<ServerProvider>): ServerConfig {
  return { providers } as ServerConfig;
}

describe("resolveStandaloneThreadTarget", () => {
  it("uses the selected environment and its default available provider model", () => {
    const local = EnvironmentId.make("local");
    const remote = EnvironmentId.make("remote");
    const target = resolveStandaloneThreadTarget(
      new Map([
        [local, config([provider()])],
        [remote, config([provider({ instanceId: ProviderInstanceId.make("claude") })])],
      ]),
      remote,
    );

    expect(target).toEqual({
      environmentId: remote,
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "best" },
    });
  });

  it("waits when the selected environment has no usable provider", () => {
    const local = EnvironmentId.make("local");
    expect(
      resolveStandaloneThreadTarget(
        new Map([[local, config([provider({ enabled: false })])]]),
        local,
      ),
    ).toBeNull();
  });

  it("chooses an available environment when the list is unscoped", () => {
    const unavailable = EnvironmentId.make("unavailable");
    const ready = EnvironmentId.make("ready");
    const target = resolveStandaloneThreadTarget(
      new Map([
        [
          unavailable,
          config([provider({ availability: "unavailable", enabled: false, installed: false })]),
        ],
        [ready, config([provider({ models: [] })])],
      ]),
      null,
    );

    expect(target).toEqual({
      environmentId: ready,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "auto" },
    });
  });
});

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { describe, expect, it } from "vite-plus/test";

import { getProviderGateway } from "@t3tools/contracts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeGatewayAgents,
  resolveOpenCodeGatewayAgentsInPrompt,
  makeOpenCodeGatewayConfig,
  openCodeGatewayModels,
  OpenCodeRuntimeLive,
  resolveOpenCodeConfigContent,
  resolveOpenCodeServerPassword,
  verifyOpenCodeServerVersion,
} from "./opencodeRuntime.ts";

describe("resolveOpenCodeConfigContent", () => {
  it("prefers the caller environment over the inherited environment", () => {
    expect(
      resolveOpenCodeConfigContent(
        { OPENCODE_CONFIG_CONTENT: '{"source":"caller"}' },
        { OPENCODE_CONFIG_CONTENT: '{"source":"process"}' },
      ),
    ).toBe('{"source":"caller"}');
  });

  it("falls back to the inherited environment and then an empty config", () => {
    expect(
      resolveOpenCodeConfigContent(undefined, {
        OPENCODE_CONFIG_CONTENT: '{"source":"process"}',
      }),
    ).toBe('{"source":"process"}');
    expect(resolveOpenCodeConfigContent(undefined, {})).toBe("{}");
  });
});

describe("OpenCode RouteMux config", () => {
  const gateway = getProviderGateway("routemux-opencode");

  it("filters Claude models and normalizes the gateway prefix", () => {
    const models = openCodeGatewayModels(
      [
        { slug: "routemux/minimax/minimax-m3", name: "MiniMax M3" },
        { slug: "anthropic/claude-opus-5", name: "Claude Opus 5" },
        { slug: "deepseek/deepseek-v4-pro-cheap", name: "DeepSeek V4 Pro Cheap" },
      ],
      "routemux",
    );

    expect(models).toEqual([
      { slug: "deepseek/deepseek-v4-pro-cheap", name: "DeepSeek V4 Pro Cheap" },
      { slug: "minimax/minimax-m3", name: "MiniMax M3" },
    ]);
  });

  it("generates a credential-free provider config from the supplied live catalog", () => {
    expect(gateway).toBeDefined();
    const models = [
      { slug: "minimax/minimax-m3", name: "A user-selected coordinator" },
      { slug: "deepseek/deepseek-v4-pro-relay", name: "A user-selected reviewer" },
    ];
    const config = JSON.parse(makeOpenCodeGatewayConfig({ gateway: gateway!, models })) as {
      provider: Record<
        string,
        {
          npm: string;
          options: { baseURL: string; apiKey: string };
          models: Record<string, { name: string }>;
        }
      >;
      agent: Record<string, { mode: string; model?: string }>;
    };
    const provider = config.provider.routemux!;

    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.options.baseURL).toBe("https://api.routemux.com/v1");
    expect(provider.options.apiKey).toBe("{env:ROUTEMUX_API_KEY}");
    expect(provider.models["minimax/minimax-m3"]).toEqual({
      name: "A user-selected coordinator",
    });
    expect(config.agent.reviewer).toEqual({
      mode: "subagent",
    });
    expect(JSON.stringify(config)).toContain("deepseek-v4-pro-relay");
    expect(JSON.stringify(config)).not.toContain("deepseek-v4-pro-cheap");
    expect(config.agent.reviewer?.model).toBeUndefined();
    expect(config.agent["routemux-deepseek-deepseek-v4-pro-relay"]).toMatchObject({
      mode: "subagent",
      model: "routemux/deepseek/deepseek-v4-pro-relay",
    });
    expect(JSON.stringify(config)).not.toContain("sk-");
    expect(JSON.stringify(config).toLowerCase()).not.toContain("claude");
  });

  it("resolves an explicit model mention to its generated subagent", () => {
    const agents = openCodeGatewayAgents(
      [
        { slug: "minimax/minimax-m3", name: "MiniMax M3" },
        { slug: "deepseek/deepseek-v4-pro-relay", name: "DeepSeek V4 Pro Relay" },
      ],
      "routemux",
    );

    expect(
      resolveOpenCodeGatewayAgentsInPrompt({
        text: "Chame um agent em Deepseek V4 Pro Relay que simplesmente diga oi.",
        agents,
      }).map((agent) => agent.slug),
    ).toEqual(["deepseek/deepseek-v4-pro-relay"]);
  });

  it("does not turn an ordinary coordinator mention into a child agent", () => {
    const agents = openCodeGatewayAgents(
      [{ slug: "minimax/minimax-m3", name: "MiniMax M3" }],
      "routemux",
    );

    expect(
      resolveOpenCodeGatewayAgentsInPrompt({
        text: "Use MiniMax M3 como coordenador desta tarefa.",
        agents,
      }),
    ).toEqual([]);
  });

  it("matches the model portion of a slug when the gateway has no display name", () => {
    const agents = openCodeGatewayAgents(
      [{ slug: "deepseek/deepseek-v4-pro-relay", name: "deepseek/deepseek-v4-pro-relay" }],
      "routemux",
    );

    expect(
      resolveOpenCodeGatewayAgentsInPrompt({
        text: "Use DeepSeek V4 Pro Relay as a reviewer agent.",
        agents,
      }).map((agent) => agent.slug),
    ).toEqual(["deepseek/deepseek-v4-pro-relay"]);
  });

  it("does not invent models or role assignments when RouteMux has no catalog", () => {
    const config = JSON.parse(makeOpenCodeGatewayConfig({ gateway: gateway!, models: [] })) as {
      provider: Record<string, { models: Record<string, unknown> }>;
      agent: Record<string, { mode: string; model?: string }>;
    };

    expect(config.provider.routemux?.models).toEqual({});
    expect(config.agent.reviewer).toEqual({ mode: "subagent" });
    expect(JSON.stringify(config)).not.toMatch(/minimax|deepseek|glm|gpt|"model"\s*:/iu);
  });
});

describe("resolveOpenCodeServerPassword", () => {
  it("uses the local environment password when settings do not provide one", () => {
    expect(
      resolveOpenCodeServerPassword(
        { external: false, environment: { OPENCODE_SERVER_PASSWORD: " env password " } },
        {},
      ),
    ).toBe(" env password ");
  });

  it("uses the settings password for a local server", () => {
    expect(
      resolveOpenCodeServerPassword({ external: false, serverPassword: " settings password " }, {}),
    ).toBe(" settings password ");
  });

  it("uses the settings password when local settings and environment differ", () => {
    expect(
      resolveOpenCodeServerPassword(
        {
          external: false,
          serverPassword: "settings-password",
          environment: { OPENCODE_SERVER_PASSWORD: "environment-password" },
        },
        {},
      ),
    ).toBe("settings-password");
  });

  it("does not send an inherited local password to an external server", () => {
    expect(
      resolveOpenCodeServerPassword(
        { external: true, environment: { OPENCODE_SERVER_PASSWORD: "local-secret" } },
        { OPENCODE_SERVER_PASSWORD: "inherited-secret" },
      ),
    ).toBeUndefined();
  });
});

function makeHealthClient(
  result: (options?: { readonly signal?: AbortSignal }) => Promise<unknown>,
): OpencodeClient {
  return {
    global: {
      health: result,
    },
  } as unknown as OpencodeClient;
}

describe("verifyOpenCodeServerVersion", () => {
  effectIt.effect("accepts a supported server version", () =>
    Effect.gen(function* () {
      const version = yield* verifyOpenCodeServerVersion(
        makeHealthClient(() => Promise.resolve({ data: { healthy: true, version: "1.14.19" } })),
      );
      expect(version).toBe("1.14.19");
    }),
  );

  effectIt.effect("rejects a server below the supported version", () =>
    Effect.gen(function* () {
      const error = yield* verifyOpenCodeServerVersion(
        makeHealthClient(() => Promise.resolve({ data: { healthy: true, version: "1.14.18" } })),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OpenCodeRuntimeError);
      expect(error.detail).toContain("v1.14.18 is too old");
    }),
  );

  for (const data of [
    { healthy: true },
    { healthy: true, version: "not-a-version" },
    { healthy: false, version: "1.14.19" },
  ]) {
    effectIt.effect(`rejects an invalid health response: ${JSON.stringify(data)}`, () =>
      Effect.gen(function* () {
        const error = yield* verifyOpenCodeServerVersion(
          makeHealthClient(() => Promise.resolve({ data })),
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(OpenCodeRuntimeError);
        expect(error.detail).toContain("requires OpenCode v1.14.19 or newer");
      }),
    );
  }

  effectIt.effect("preserves an unauthorized health error", () =>
    Effect.gen(function* () {
      const error = yield* verifyOpenCodeServerVersion(
        makeHealthClient(() =>
          Promise.reject({ response: { status: 401 }, error: { message: "Unauthorized" } }),
        ),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OpenCodeRuntimeError);
      expect(error.detail).toContain("status=401");
      expect(error.detail).toContain("Unauthorized");
    }),
  );

  effectIt.effect("aborts a health request when the version check times out", () =>
    Effect.gen(function* () {
      let requestSignal: AbortSignal | undefined;
      const checkFiber = yield* verifyOpenCodeServerVersion(
        makeHealthClient((options) => {
          requestSignal = options?.signal;
          return new Promise(() => undefined);
        }),
      ).pipe(Effect.flip, Effect.forkChild);

      yield* Effect.yieldNow;
      expect(requestSignal).toBeDefined();
      yield* TestClock.adjust("6 seconds");

      const error = yield* Fiber.join(checkFiber);
      expect(error.detail).toBe("Timed out while checking the OpenCode server version.");
      expect(requestSignal?.aborted).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("OpenCode server output", () => {
  effectIt.live(
    "drains stdout and stderr after startup so server requests can finish",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const environment = yield* HostProcessEnvironment;
        const executablePath = yield* HostProcessExecutablePath;
        const platform = yield* HostProcessPlatform;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-output-" });
        const isWindows = platform === "win32";
        const binaryPath = path.join(tempDir, isWindows ? "opencode.cmd" : "opencode");
        const scriptPath = path.join(tempDir, "opencode.mjs");

        yield* fs.writeFileString(
          scriptPath,
          `import { createServer } from "node:http";
const writeOutput = (stream) => new Promise((resolve, reject) => {
  stream.write("x".repeat(2 * 1024 * 1024), (error) => error ? reject(error) : resolve());
});
const server = createServer(async (request, response) => {
  if (request.url.startsWith("/global/health")) {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ healthy: true, version: "1.14.19" }));
    return;
  }
  await Promise.all([writeOutput(process.stdout), writeOutput(process.stderr)]);
  response.end("drained");
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("opencode server listening on http://127.0.0.1:" + server.address().port + "\\n");
});
`,
        );
        yield* fs.writeFileString(
          binaryPath,
          [
            ...(isWindows ? ["@echo off"] : ["#!/bin/sh"]),
            isWindows
              ? '"%T3_TEST_NODE_BINARY%" "%T3_TEST_OPENCODE_SCRIPT%" %*'
              : 'exec "$T3_TEST_NODE_BINARY" "$T3_TEST_OPENCODE_SCRIPT" "$@"',
            "",
          ].join("\n"),
        );
        if (!isWindows) {
          yield* fs.chmod(binaryPath, 0o755);
        }

        const runtime = yield* OpenCodeRuntime;
        const server = yield* runtime.startOpenCodeServerProcess({
          binaryPath,
          directory: tempDir,
          port: 0,
          environment: {
            ...environment,
            T3_TEST_NODE_BINARY: executablePath,
            T3_TEST_OPENCODE_SCRIPT: scriptPath,
          },
        });
        const response = yield* HttpClient.get(`${server.url}/output`);

        expect(yield* response.text).toBe("drained");
        expect(yield* server.isRunning).toBe(true);
      }).pipe(
        Effect.scoped,
        Effect.provide([
          OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer)),
          FetchHttpClient.layer,
        ]),
      ),
    10_000,
  );
});

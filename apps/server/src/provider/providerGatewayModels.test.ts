import { getProviderGateway, type ProviderGatewayDefinition } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http";

import {
  fetchGatewayModels,
  gatewayModelsFromListing,
  makeGatewayModelSource,
} from "./providerGatewayModels.ts";

const routemux = getProviderGateway("routemux") as ProviderGatewayDefinition;
const routemuxCodex = getProviderGateway("routemux-codex") as ProviderGatewayDefinition;
const routemuxOpenCode = getProviderGateway("routemux-opencode") as ProviderGatewayDefinition;

const environment: NodeJS.ProcessEnv = {
  ANTHROPIC_AUTH_TOKEN: "sk-routemux-test",
  ANTHROPIC_BASE_URL: "https://api.routemux.com",
};

const codexEnvironment: NodeJS.ProcessEnv = {
  ROUTEMUX_API_KEY: "sk-routemux-test",
  ROUTEMUX_BASE_URL: "https://api.routemux.com/v1",
};

const openCodeEnvironment: NodeJS.ProcessEnv = {
  ROUTEMUX_API_KEY: "sk-routemux-test",
  ROUTEMUX_BASE_URL: "https://api.routemux.com/v1",
};

function stubClient(
  handler: (request: HttpClientRequest.HttpClientRequest) => Response,
): HttpClient.HttpClient {
  return HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))),
  );
}

const listing = (body: unknown) => stubClient(() => Response.json(body));

describe("gatewayModelsFromListing", () => {
  it("keeps gateway ids verbatim and prefers a human label", () => {
    expect(
      gatewayModelsFromListing({
        data: [
          { id: "openai/gpt-5.6-sol", display_name: "GPT-5.6 Sol" },
          { id: "anthropic/claude-opus-5", name: "Claude Opus 5" },
          { id: "deepseek/deepseek-v4-pro" },
        ],
      }),
    ).toEqual([
      {
        slug: "anthropic/claude-opus-5",
        name: "Claude Opus 5",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "deepseek/deepseek-v4-pro",
        name: "deepseek/deepseek-v4-pro",
        isCustom: false,
        capabilities: null,
      },
      { slug: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", isCustom: false, capabilities: null },
    ]);
  });

  it("drops blank and duplicate ids", () => {
    expect(
      gatewayModelsFromListing({
        data: [{ id: "a" }, { id: "  " }, { id: "a", name: "second" }],
      }).map((model) => model.slug),
    ).toEqual(["a"]);
  });

  // Gateway models are never `isCustom`: the picker treats the first
  // non-custom entry as the default, so marking them custom would leave a
  // gateway instance defaulting to a model its key cannot call.
  it("reports gateway models as built-in, not user-authored", () => {
    expect(gatewayModelsFromListing({ data: [{ id: "a" }] })[0]?.isCustom).toBe(false);
  });
});

/**
 * Verbatim excerpt of a real `GET https://api.routemux.com/v1/models`
 * response. Kept as a fixture because the listing carries far more per-model
 * metadata than we read, and the parser must keep ignoring it rather than
 * rejecting the whole catalog when the gateway adds another field.
 */
const ROUTEMUX_LISTING = {
  object: "list",
  data: [
    {
      id: "openai/gpt-6-astra",
      object: "model",
      owned_by: "openai",
      created: 1788393600,
      display_name: "GPT-6 Astra",
      canonical_slug: "openai/gpt-6-astra",
      context_length: 1050000,
      max_output_tokens: 128000,
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      capabilities: {
        cache: true,
        coding: true,
        vision: true,
        reasoning: true,
        tool_calling: true,
        service_tiers: ["priority"],
      },
      supported_parameters: ["frequency_penalty", "include", "max_output_tokens"],
    },
  ],
};

describe("fetchGatewayModels", () => {
  it.effect("reads a real RouteMux listing, ignoring metadata it does not use", () =>
    fetchGatewayModels({ gateway: routemux, environment }).pipe(
      Effect.provideService(HttpClient.HttpClient, listing(ROUTEMUX_LISTING)),
      Effect.map((models) => {
        expect(models).toEqual([
          {
            slug: "openai/gpt-6-astra",
            name: "GPT-6 Astra",
            isCustom: false,
            capabilities: null,
          },
        ]);
      }),
    ),
  );

  it.effect("reads the catalog with a bearer key from the instance environment", () =>
    Effect.gen(function* () {
      let seen: { url: string; authorization: string | undefined } | undefined;
      const models = yield* fetchGatewayModels({ gateway: routemux, environment }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          stubClient((request) => {
            seen = { url: request.url, authorization: request.headers.authorization };
            return Response.json({ data: [{ id: "openai/gpt-5.6-sol" }] });
          }),
        ),
      );
      expect(seen?.url).toBe("https://api.routemux.com/v1/models");
      expect(seen?.authorization).toBe("Bearer sk-routemux-test");
      expect(models.map((model) => model.slug)).toEqual(["openai/gpt-5.6-sol"]);
    }),
  );

  it.effect("honors a base URL overridden on the instance, without doubling slashes", () =>
    Effect.gen(function* () {
      let url: string | undefined;
      yield* fetchGatewayModels({
        gateway: routemux,
        environment: { ...environment, ANTHROPIC_BASE_URL: "https://proxy.internal/" },
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          stubClient((request) => {
            url = request.url;
            return Response.json({ data: [{ id: "a" }] });
          }),
        ),
      );
      expect(url).toBe("https://proxy.internal/v1/models");
    }),
  );

  it.effect("uses the Codex catalog filter for Responses models with tool calling", () =>
    Effect.gen(function* () {
      let url: string | undefined;
      yield* fetchGatewayModels({ gateway: routemuxCodex, environment: codexEnvironment }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          stubClient((request) => {
            url = request.url;
            return Response.json({ data: [{ id: "minimax/minimax-m3" }] });
          }),
        ),
      );
      expect(url).toBe(
        "https://api.routemux.com/v1/models?protocol=openai_responses&capability=tool_calling",
      );
    }),
  );

  it.effect("uses the OpenCode catalog filter for Chat models with tool calling", () =>
    Effect.gen(function* () {
      let url: string | undefined;
      yield* fetchGatewayModels({
        gateway: routemuxOpenCode,
        environment: openCodeEnvironment,
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          stubClient((request) => {
            url = request.url;
            return Response.json({ data: [{ id: "minimax/minimax-m3" }] });
          }),
        ),
      );
      expect(url).toBe(
        "https://api.routemux.com/v1/models?protocol=openai_chat&capability=tool_calling",
      );
    }),
  );

  it.effect("fails without reaching the network when no key is configured", () =>
    fetchGatewayModels({ gateway: routemux, environment: {} }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("must not request a listing without a key")),
      ),
      Effect.flip,
      Effect.map((error) => {
        expect(error.message).toMatch(/API key/u);
      }),
    ),
  );

  it.effect("distinguishes a rejected key from other upstream failures", () =>
    Effect.gen(function* () {
      const rejected = yield* fetchGatewayModels({ gateway: routemux, environment }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          stubClient(() => new Response("{}", { status: 401 })),
        ),
        Effect.flip,
      );
      expect(rejected.message).toMatch(/rejected the configured API key/u);

      const upstream = yield* fetchGatewayModels({ gateway: routemux, environment }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          stubClient(() => new Response("{}", { status: 503 })),
        ),
        Effect.flip,
      );
      expect(upstream.message).toMatch(/HTTP 503/u);
    }),
  );

  it.effect("rejects a listing shape it cannot read, and an empty one", () =>
    Effect.gen(function* () {
      const malformed = yield* fetchGatewayModels({ gateway: routemux, environment }).pipe(
        Effect.provideService(HttpClient.HttpClient, listing({ models: ["a"] })),
        Effect.flip,
      );
      expect(malformed.message).toMatch(/unexpected model listing shape/u);

      const empty = yield* fetchGatewayModels({ gateway: routemux, environment }).pipe(
        Effect.provideService(HttpClient.HttpClient, listing({ data: [] })),
        Effect.flip,
      );
      expect(empty.message).toMatch(/listed no models/u);
    }),
  );
});

describe("makeGatewayModelSource", () => {
  it.effect("is absent for a non-gateway instance", () =>
    makeGatewayModelSource({
      gateway: undefined,
      environment,
      httpClient: HttpClient.make(() =>
        Effect.die("a plain instance must not list gateway models"),
      ),
    }).pipe(
      Effect.map((source) => {
        expect(source).toBeUndefined();
      }),
    ),
  );

  it.effect("caches a successful listing instead of refetching per snapshot", () =>
    Effect.gen(function* () {
      let requests = 0;
      const source = yield* makeGatewayModelSource({
        gateway: routemux,
        environment,
        httpClient: stubClient(() => {
          requests += 1;
          return Response.json({ data: [{ id: "openai/gpt-5.6-sol" }] });
        }),
      });
      const first = yield* source!.read;
      const second = yield* source!.read;
      expect(requests).toBe(1);
      expect(first.models?.map((model) => model.slug)).toEqual(["openai/gpt-5.6-sol"]);
      expect(first.reason).toBeUndefined();
      expect(second).toEqual(first);
    }),
  );

  // The caller keeps its own catalog when `models` is absent, and shows
  // `reason` so the fallback is not mistaken for the gateway's real lineup.
  it.effect("reports why a listing failed instead of failing the snapshot", () =>
    Effect.gen(function* () {
      const source = yield* makeGatewayModelSource({
        gateway: routemux,
        environment,
        httpClient: stubClient(() => new Response("{}", { status: 500 })),
      });
      const result = yield* source!.read;
      expect(result.models).toBeUndefined();
      expect(result.reason).toMatch(/HTTP 500/u);
    }),
  );
});

/**
 * Live model discovery for gateway provider instances.
 *
 * A gateway fronts many vendors and adds models continuously, so pinning a
 * list in this repository would be wrong within weeks. The catalog is read
 * from the gateway's own OpenAI-shaped `/v1/models` listing using the
 * instance's key, which also means it reflects exactly the models that key is
 * entitled to — not everything the gateway advertises publicly.
 *
 * @module provider/providerGatewayModels
 */
import type { ProviderGatewayDefinition, ServerProviderModel } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

/**
 * OpenAI `GET /v1/models` response. Only `id` is required — gateways differ
 * on the rest, and a listing must not be rejected over a field we only use
 * for a nicer label.
 */
const GatewayModelListing = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.String),
      display_name: Schema.optional(Schema.String),
    }),
  ),
});

const decodeListing = Schema.decodeUnknownEffect(GatewayModelListing);

/**
 * Turn a decoded listing into provider models.
 *
 * Entries are `isCustom: false`: they are the instance's built-in catalog,
 * not user-authored slugs. That also makes the first entry the picker's
 * default, so a gateway instance never defaults to a model its key cannot
 * call. Capabilities are left unset — a third-party model has no Claude Code
 * reasoning/effort profile for us to claim.
 */
export function gatewayModelsFromListing(listing: {
  readonly data: ReadonlyArray<{
    readonly id: string;
    readonly name?: string | undefined;
    readonly display_name?: string | undefined;
  }>;
}): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const entry of listing.data) {
    const slug = entry.id.trim();
    if (slug.length === 0 || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: entry.display_name?.trim() || entry.name?.trim() || slug,
      isCustom: false,
      capabilities: null,
    });
  }
  return models.toSorted((left, right) => left.slug.localeCompare(right.slug));
}

export class GatewayModelsError extends Error {
  readonly _tag = "GatewayModelsError";
}

const failure = (message: string) => Effect.fail(new GatewayModelsError(message));

/**
 * Read a gateway instance's live model catalog.
 *
 * Fails rather than returning an empty list, so the caller can keep the
 * previous catalog and surface why the refresh did not land. The key is read
 * from the already-merged instance environment and never logged.
 */
export const fetchGatewayModels = Effect.fn("fetchGatewayModels")(function* (input: {
  readonly gateway: ProviderGatewayDefinition;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.fn.Return<
  ReadonlyArray<ServerProviderModel>,
  GatewayModelsError,
  HttpClient.HttpClient
> {
  const apiKey = input.environment[input.gateway.apiKeyVariable]?.trim();
  if (!apiKey) {
    return yield* failure(`No ${input.gateway.label} API key is configured for this instance.`);
  }
  // The instance may point at a self-hosted or proxied deployment, so read the
  // host from its own environment and fall back to the preset's default.
  const baseUrl = input.environment[input.gateway.baseUrlVariable]?.trim() || input.gateway.baseUrl;
  const client = yield* HttpClient.HttpClient;

  const response = yield* client
    .execute(
      HttpClientRequest.get(
        `${baseUrl.replace(/\/+$/u, "")}${input.gateway.modelsPath}${input.gateway.modelsQuery ?? ""}`,
      ).pipe(HttpClientRequest.setHeader("authorization", `Bearer ${apiKey}`)),
    )
    .pipe(
      Effect.mapError(
        () => new GatewayModelsError(`Could not reach ${input.gateway.label} to list models.`),
      ),
    );

  if (response.status === 401 || response.status === 403) {
    return yield* failure(`${input.gateway.label} rejected the configured API key.`);
  }
  if (response.status >= 400) {
    return yield* failure(
      `${input.gateway.label} returned HTTP ${response.status} while listing models.`,
    );
  }

  const body = yield* response.json.pipe(
    Effect.mapError(
      () => new GatewayModelsError(`${input.gateway.label} returned an unreadable model listing.`),
    ),
  );
  const listing = yield* decodeListing(body).pipe(
    Effect.mapError(
      () =>
        new GatewayModelsError(
          `${input.gateway.label} returned an unexpected model listing shape.`,
        ),
    ),
  );
  const models = gatewayModelsFromListing(listing);
  if (models.length === 0) {
    return yield* failure(`${input.gateway.label} listed no models for this API key.`);
  }
  return models;
});

/** How long a successful gateway listing is reused before a refetch. */
const CATALOG_TTL = Duration.minutes(30);

/**
 * Per-instance cached read of a gateway's models, or `undefined` when the
 * instance is not a gateway — which lets a driver keep its own vendor catalog
 * through the exact code path it used before.
 *
 * Deliberately returns `ServerProviderModel`s and nothing driver-shaped: how
 * a driver folds them into its catalog (and what runtime profile it assumes
 * for a third-party model) is the driver's decision, not this module's.
 */
export const makeGatewayModelSource = Effect.fn("makeGatewayModelSource")(function* (input: {
  readonly gateway: ProviderGatewayDefinition | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly httpClient: HttpClient.HttpClient;
}) {
  const { gateway } = input;
  if (!gateway) return undefined;

  const cache = yield* Cache.make({
    capacity: 1,
    timeToLive: CATALOG_TTL,
    lookup: (_key: string) =>
      fetchGatewayModels({ gateway, environment: input.environment }).pipe(
        Effect.provideService(HttpClient.HttpClient, input.httpClient),
      ),
  });

  return {
    gateway,
    /**
     * Never fails: a refresh that could not land reports `reason` instead, so
     * the caller keeps the catalog it already had — emptying the picker over a
     * transient network error would strand the instance — and can tell the
     * user why the gateway's own models are missing. A silent fallback looks
     * identical to "this gateway only serves Anthropic models", which is the
     * one conclusion we must not let the UI imply.
     */
    read: Cache.get(cache, gateway.id).pipe(
      Effect.map((models) => ({ models, reason: undefined })),
      Effect.catch((cause) =>
        Effect.logWarning("Gateway model listing unavailable; keeping the previous catalog.", {
          gateway: gateway.id,
          detail: cause.message,
        }).pipe(Effect.as({ models: undefined, reason: cause.message })),
      ),
    ),
  };
});

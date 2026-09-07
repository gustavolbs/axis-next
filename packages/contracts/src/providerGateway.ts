/**
 * Gateway presets — hosted multi-model endpoints an existing driver can be
 * pointed at instead of its vendor's own API.
 *
 * A gateway is deliberately *not* a driver. RouteMux speaks the Anthropic
 * Messages protocol, so the Claude driver runs it unchanged; the preset only
 * supplies the base URL, the credential variable, and where to read the live
 * model catalog. Everything downstream — threads, checkpoints, MCP grants, context
 * isolation, the API-billed boundary — treats the result as an ordinary
 * API-key provider instance.
 *
 * @module providerGateway
 */
import {
  ProviderDriverKind,
  ProviderGatewayId,
  type ProviderInstanceEnvironmentVariableName,
} from "./providerInstance.ts";

export interface ProviderGatewayDefinition {
  readonly id: ProviderGatewayId;
  readonly label: string;
  /** Driver that speaks this gateway's protocol. */
  readonly driver: ProviderDriverKind;
  /** Variable the driver's CLI reads to redirect its API host. */
  readonly baseUrlVariable: ProviderInstanceEnvironmentVariableName;
  readonly baseUrl: string;
  /** Variable carrying the bearer credential. Always stored as sensitive. */
  readonly apiKeyVariable: ProviderInstanceEnvironmentVariableName;
  /**
   * Variables blanked on the instance so an ambient credential in the
   * server's own environment cannot outrank the gateway key. Set to an empty
   * string rather than removed: the merge that builds the child env only
   * overwrites names it is given.
   */
  readonly clearVariables: ReadonlyArray<ProviderInstanceEnvironmentVariableName>;
  readonly consoleUrl: string;
  /**
   * Path, relative to `baseUrl`, of the OpenAI-shaped model listing. The
   * catalog is read from the live gateway with the instance's own key, so it
   * reflects exactly what that key can call — never a list pinned in this
   * repository, which would go stale every time the gateway adds a model.
   */
  readonly modelsPath: string;
}

const ROUTEMUX: ProviderGatewayDefinition = {
  id: ProviderGatewayId.make("routemux"),
  label: "RouteMux",
  // RouteMux is Anthropic-Messages compatible, so the Claude CLI drives it
  // with no protocol work: `ANTHROPIC_BASE_URL` + `/v1/messages`.
  driver: ProviderDriverKind.make("claudeAgent"),
  baseUrlVariable: "ANTHROPIC_BASE_URL",
  // Deliberately without the `/v1` suffix: Anthropic clients append
  // `/v1/messages` themselves, and `https://api.routemux.com/v1` would
  // resolve to `/v1/v1/messages`.
  baseUrl: "https://api.routemux.com",
  // `ANTHROPIC_AUTH_TOKEN` (bearer), not `ANTHROPIC_API_KEY` (x-api-key):
  // RouteMux authenticates every protocol with `Authorization: Bearer`.
  apiKeyVariable: "ANTHROPIC_AUTH_TOKEN",
  // A developer machine very often exports `ANTHROPIC_API_KEY`; inherited, it
  // competes with the bearer token and the CLI can end up billing Anthropic.
  clearVariables: ["ANTHROPIC_API_KEY"],
  consoleUrl: "https://routemux.com/console/keys",
  modelsPath: "/v1/models",
};

export const PROVIDER_GATEWAYS: ReadonlyArray<ProviderGatewayDefinition> = [ROUTEMUX];

const BY_ID: ReadonlyMap<string, ProviderGatewayDefinition> = new Map(
  PROVIDER_GATEWAYS.map((gateway) => [gateway.id, gateway] as const),
);

/**
 * Resolve a gateway preset. Returns `undefined` for an id this build does not
 * ship, which is the expected outcome for fork- or future-defined gateways
 * read out of persisted settings.
 */
export function getProviderGateway(
  id: ProviderGatewayId | string | undefined,
): ProviderGatewayDefinition | undefined {
  return id === undefined ? undefined : BY_ID.get(id);
}

/** Env variables a gateway instance must carry, key first. */
export function providerGatewayEnvironment(
  gateway: ProviderGatewayDefinition,
  apiKey: string,
): ReadonlyArray<{ readonly name: string; readonly value: string; readonly sensitive: boolean }> {
  return [
    { name: gateway.apiKeyVariable, value: apiKey, sensitive: true },
    { name: gateway.baseUrlVariable, value: gateway.baseUrl, sensitive: false },
    ...gateway.clearVariables.map((name) => ({ name, value: "", sensitive: false })),
  ];
}

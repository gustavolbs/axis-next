import {
  getProviderGateway,
  providerGatewayEnvironment,
  type ProviderDriverKind,
  type ProviderGatewayDefinition,
  type ProviderGatewayId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@t3tools/contracts";

export type WizardNavigation =
  | { readonly kind: "navigate"; readonly step: number }
  | { readonly kind: "blocked"; readonly step: number; readonly error: string };

const IDENTITY_STEP = 1;

export const ADD_PROVIDER_WIZARD_STEPS = ["Driver", "Identity", "Config"] as const;

const API_KEY_ENVIRONMENT_VARIABLES: Readonly<Record<string, string>> = {
  codex: "OPENAI_API_KEY",
  claudeAgent: "ANTHROPIC_API_KEY",
};

export function apiKeyEnvironmentVariableForDriver(driver: ProviderDriverKind): string | null {
  return API_KEY_ENVIRONMENT_VARIABLES[driver] ?? null;
}

/**
 * Point the instance at its own CLI home unless the wizard supplied one.
 * Codex isolates through `shadowHomePath`, every other driver through
 * `homePath`. Non-auth configuration from the wizard is preserved.
 */
function withIsolatedProviderHome(
  driver: ProviderDriverKind,
  instanceId: ProviderInstanceId,
  config: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const isolatedHome = `~/.t3/provider-homes/${instanceId}`;
  const key = driver === "codex" ? "shadowHomePath" : "homePath";
  const configured = config[key];
  const resolved =
    typeof configured === "string" && configured.trim().length > 0
      ? configured.trim()
      : isolatedHome;
  return { ...config, [key]: resolved };
}

/**
 * API-key providers get an isolated CLI home so an existing subscription
 * login cannot silently win over the explicit key. Non-auth configuration
 * from the wizard is preserved.
 */
export function buildApiKeyProviderInstance(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName?: string;
  readonly accentColor?: string;
  readonly apiKey: string;
  readonly config: Readonly<Record<string, unknown>>;
}): ProviderInstanceConfig {
  const environmentVariable = apiKeyEnvironmentVariableForDriver(input.driver);
  if (!environmentVariable) {
    throw new Error(`Provider '${input.driver}' does not support an API-key preset.`);
  }
  const apiKey = input.apiKey.trim();
  if (apiKey.length === 0) {
    throw new Error("API key is required for an API-key provider instance.");
  }
  const config = withIsolatedProviderHome(input.driver, input.instanceId, input.config);
  return {
    driver: input.driver,
    enabled: true,
    credentialSource: "api-key",
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    environment: [
      {
        name: environmentVariable,
        value: apiKey,
        sensitive: true,
      },
    ],
    config,
  };
}

/**
 * A gateway instance is an API-key instance whose driver is aimed at a
 * hosted multi-model endpoint. It carries the same isolated home and
 * sensitive-secret handling, plus the base-URL variable, and records which
 * preset produced it.
 *
 * No model list is written here: the server reads the gateway's live catalog
 * with this key, so the picker shows exactly what the key can call and stays
 * correct as the gateway's lineup changes.
 */
export function buildGatewayProviderInstance(input: {
  readonly instanceId: ProviderInstanceId;
  readonly gateway: ProviderGatewayDefinition;
  readonly displayName?: string;
  readonly accentColor?: string;
  readonly apiKey: string;
  readonly config: Readonly<Record<string, unknown>>;
}): ProviderInstanceConfig {
  const apiKey = input.apiKey.trim();
  if (apiKey.length === 0) {
    throw new Error(`An API key is required for a ${input.gateway.label} provider instance.`);
  }
  const config = withIsolatedProviderHome(input.gateway.driver, input.instanceId, input.config);
  return {
    driver: input.gateway.driver,
    enabled: true,
    credentialSource: "api-key",
    gateway: input.gateway.id,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    environment: providerGatewayEnvironment(input.gateway, apiKey),
    config,
  };
}

/**
 * The driver step offers drivers and gateway presets in one radio group, so
 * its value is either a driver slug or `gateway:<id>`. These two functions
 * are the only place that encoding is known.
 */
export function providerSelectionValue(
  driver: ProviderDriverKind,
  gateway: ProviderGatewayId | null,
): string {
  return gateway ? `gateway:${gateway}` : driver;
}

export function parseProviderSelection(value: string): {
  readonly driver: ProviderDriverKind;
  readonly gateway: ProviderGatewayDefinition | null;
} | null {
  if (!value.startsWith("gateway:")) return null;
  const gateway = getProviderGateway(value.slice("gateway:".length));
  return gateway ? { driver: gateway.driver, gateway } : null;
}

/**
 * Resolve navigation within the add-provider wizard.
 *
 * Moving forward past Identity requires a valid instance id, whether the user
 * advances one step at a time or skips directly to Config from a step header.
 * A blocked skip lands on Identity so its existing inline validation is
 * visible. Backward navigation is always preserved.
 */
export function resolveWizardNavigation(
  currentStep: number,
  requestedStep: number,
  stepCount: number,
  validation: { readonly instanceIdError: string | null },
): WizardNavigation {
  const lastStep = Math.max(0, stepCount - 1);
  const targetStep = Math.max(0, Math.min(lastStep, requestedStep));
  const movesForwardPastIdentity = currentStep <= IDENTITY_STEP && targetStep > IDENTITY_STEP;

  if (movesForwardPastIdentity && validation.instanceIdError !== null) {
    return {
      kind: "blocked",
      step: Math.min(IDENTITY_STEP, lastStep),
      error: validation.instanceIdError,
    };
  }

  return { kind: "navigate", step: targetStep };
}

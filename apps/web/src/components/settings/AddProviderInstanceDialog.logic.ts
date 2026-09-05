import type {
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceId,
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
  const isolatedHome = `~/.t3/provider-homes/${input.instanceId}`;
  const configuredHome =
    typeof input.config.homePath === "string" && input.config.homePath.trim().length > 0
      ? input.config.homePath.trim()
      : isolatedHome;
  const configuredShadowHome =
    typeof input.config.shadowHomePath === "string" && input.config.shadowHomePath.trim().length > 0
      ? input.config.shadowHomePath.trim()
      : isolatedHome;
  const config =
    input.driver === "codex"
      ? { ...input.config, shadowHomePath: configuredShadowHome }
      : { ...input.config, homePath: configuredHome };
  return {
    driver: input.driver,
    enabled: true,
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

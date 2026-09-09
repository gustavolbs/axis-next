import type {
  ProviderInstanceId,
  TokenEfficiencyConciseOutputProfile,
  TokenEfficiencySettings,
} from "@t3tools/contracts";
import { buildConciseOutputInstruction } from "@t3tools/contracts";

/** Resolve the global profile, with a provider-instance override taking precedence. */
export function resolveConciseOutputProfile(
  settings: TokenEfficiencySettings | undefined,
  instanceId: ProviderInstanceId | undefined,
): TokenEfficiencyConciseOutputProfile | undefined {
  const instance = instanceId === undefined ? undefined : settings?.byInstance?.[instanceId];
  return instance?.conciseOutput ?? settings?.conciseOutput;
}

/**
 * Stable provider prompt prefix. Keep model, effort, and opt-in verbosity
 * controls out of this block so providers that cache a prompt prefix can keep
 * the same cache key while a session changes its turn-level settings.
 */
export function buildStableRuntimePromptPrefix(harness: string): string {
  const normalizedHarness = toSingleLine(harness);
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${normalizedHarness} harness. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>`;
}

/** Shared runtime context; omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly conciseOutputProfile?: TokenEfficiencyConciseOutputProfile | undefined;
}): string {
  const model = toSingleLine(runtime.model ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${model}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const runtimeMetadata =
    modelInfo || effortInfo
      ? `<runtime_metadata>Current turn settings${modelInfo}${effortInfo}.</runtime_metadata>`
      : undefined;
  const conciseOutputInstruction = buildConciseOutputInstruction(runtime.conciseOutputProfile);
  return [
    buildStableRuntimePromptPrefix(runtime.harness),
    runtimeMetadata,
    conciseOutputInstruction,
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n\n");
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

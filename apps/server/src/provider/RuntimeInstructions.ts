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

/** Shared runtime context; omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly conciseOutputProfile?: TokenEfficiencyConciseOutputProfile | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${model}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const runtimeInfo = `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>`;
  const conciseOutputInstruction = buildConciseOutputInstruction(runtime.conciseOutputProfile);
  return conciseOutputInstruction === undefined
    ? runtimeInfo
    : `${runtimeInfo}\n\n${conciseOutputInstruction}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

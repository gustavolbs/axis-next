import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type {
  PreviewAutomationOperation,
  PreviewAutomationOpenInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeResult,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewTabId,
} from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { makeTokenEfficiencyEngine } from "../../../tokenEfficiency/TokenEfficiencyEngine.ts";
import { resolveTokenEfficiency } from "@t3tools/contracts";
import * as TokenEfficiencyMetrics from "../../../tokenEfficiency/TokenEfficiencyMetrics.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit, PreviewToolkit } from "./tools.ts";

/**
 * Collapses the `show` alias onto `open` and defaults tab reuse.
 *
 * Deliberately leaves an unstated `open` unstated. Whether a preview the agent
 * said nothing about surfaces is the user's `browserAutoShowFloatingPreview`
 * preference, which is desktop-local and unreadable from here — filling in
 * `true` would silently override it for every `preview_open`.
 */
export function normalizePreviewOpenInput(
  input: PreviewAutomationOpenInput,
): PreviewAutomationOpenInput {
  const open = input.open ?? input.show;
  return {
    ...input,
    ...(open === undefined ? {} : { open, show: open }),
    reuseExistingTab: input.reuseExistingTab ?? true,
  };
}

const invoke = Effect.fn("PreviewToolkit.invoke")(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs?: number,
  tabId?: PreviewTabId,
): Effect.fn.Return<
  A,
  import("@t3tools/contracts").PreviewAutomationError,
  McpInvocationContext.McpInvocationContext | PreviewAutomationBroker.PreviewAutomationBroker
> {
  const scope = yield* McpInvocationContext.requireMcpCapability("preview");
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  return yield* broker.invoke<A>({
    scope,
    operation,
    input,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(tabId === undefined ? {} : { tabId }),
  });
});

const invokeTargeted = <A>(
  operation: PreviewAutomationOperation,
  input: {
    readonly tabId?: PreviewTabId | undefined;
    readonly [key: string]: unknown;
  },
  timeoutMs?: number,
) => {
  const { tabId, ...operationInput } = input;
  return invoke<A>(operation, operationInput, timeoutMs, tabId);
};

const tokenEfficiencyEngine = makeTokenEfficiencyEngine();

/**
 * Compacts only an unstructured tool result. Structured results stay typed and
 * lossless; the textual representation is the provider-facing payload that can
 * safely be evaluated by the token-efficiency engine.
 */
export const compactPreviewToolResult = (result: unknown) =>
  Effect.gen(function* () {
    if (typeof result !== "string") return result;
    const invocation = yield* McpInvocationContext.requireMcpCapability("preview");
    const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    const resolved = yield* Option.match(settings, {
      onNone: () =>
        Effect.succeed(resolveTokenEfficiency(undefined, invocation.providerInstanceId)),
      onSome: (service) =>
        service.getSettings.pipe(
          Effect.map(({ tokenEfficiency }) =>
            resolveTokenEfficiency(tokenEfficiency, invocation.providerInstanceId),
          ),
          Effect.orElseSucceed(() =>
            resolveTokenEfficiency(undefined, invocation.providerInstanceId),
          ),
        ),
    });
    const outcome = yield* tokenEfficiencyEngine.compact({
      text: result,
      kind: "tool-result",
      contextKey: `${invocation.environmentId}\u0000${invocation.threadId}`,
      mode: resolved.mode,
      engine: resolved.engine,
    });
    const metrics = yield* TokenEfficiencyMetrics.TokenEfficiencyMetrics;
    if (invocation.provider !== undefined) {
      yield* metrics.recordCompaction({
        provider: invocation.provider,
        providerInstanceId: invocation.providerInstanceId,
        payloadKind: "tool-result",
        ...(invocation.model === undefined ? {} : { model: invocation.model }),
        contextId: invocation.contextId ?? null,
        outcome,
      });
    }
    return outcome.applied && outcome.recoveryHandle !== undefined
      ? {
          value: outcome.text,
          tokenEfficiency: {
            engine: outcome.engine,
            recoveryHandle: outcome.recoveryHandle,
            estimatedTokensBefore: outcome.estimatedTokensBefore,
            estimatedTokensAfter: outcome.estimatedTokensAfter,
          },
        }
      : outcome.text;
  });

export const recoverPreviewToolPayload = (handle: string) =>
  Effect.gen(function* () {
    const invocation = yield* McpInvocationContext.requireMcpCapability("preview");
    return (
      (yield* tokenEfficiencyEngine.recover({
        contextKey: `${invocation.environmentId}\u0000${invocation.threadId}`,
        handle,
      })) ?? null
    );
  });

const handlers = {
  preview_status: (input) => invokeTargeted<PreviewAutomationStatus>("status", input ?? {}),
  preview_open: (input) =>
    invokeTargeted<PreviewAutomationStatus>("open", normalizePreviewOpenInput(input)),
  preview_navigate: (input) =>
    invokeTargeted<PreviewAutomationStatus>("navigate", input, input.timeoutMs),
  preview_resize: (input) =>
    invokeTargeted<PreviewAutomationResizeResult>("resize", input, input.timeoutMs),
  preview_set_appearance: (input) =>
    invokeTargeted<PreviewAutomationSetColorSchemeResult>("setColorScheme", input),
  preview_snapshot: (input) => invokeTargeted<PreviewAutomationSnapshot>("snapshot", input ?? {}),
  preview_click: (input) =>
    invokeTargeted<void>("click", input, input.timeoutMs).pipe(Effect.as({})),
  preview_type: (input) => invokeTargeted<void>("type", input, input.timeoutMs).pipe(Effect.as({})),
  preview_press: (input) => invokeTargeted<void>("press", input).pipe(Effect.as({})),
  preview_scroll: (input) => invokeTargeted<void>("scroll", input).pipe(Effect.as({})),
  preview_evaluate: (input) =>
    invokeTargeted<unknown>("evaluate", input).pipe(
      Effect.flatMap(compactPreviewToolResult),
      Effect.map((result) => result ?? null),
    ),
  preview_recover: (input) => recoverPreviewToolPayload(input.handle),
  preview_wait_for: (input) =>
    invokeTargeted<void>("waitFor", input, input.timeoutMs).pipe(Effect.as({})),
  preview_recording_start: (input) =>
    invokeTargeted<PreviewAutomationRecordingStatus>("recordingStart", input ?? {}),
  preview_recording_stop: (input) =>
    invokeTargeted<PreviewAutomationRecordingArtifact>("recordingStop", input ?? {}),
} satisfies Parameters<typeof PreviewToolkit.toLayer>[0];

const { preview_snapshot, ...standardHandlers } = handlers;

export const PreviewStandardToolkitHandlersLive = PreviewStandardToolkit.toLayer(standardHandlers);

export const PreviewSnapshotToolkitHandlersLive = PreviewSnapshotToolkit.toLayer({
  preview_snapshot,
});

export const PreviewToolkitHandlersLive = PreviewToolkit.toLayer(handlers);

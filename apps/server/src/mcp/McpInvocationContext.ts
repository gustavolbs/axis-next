import {
  type AxisContextId,
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability = "preview";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** Model selected when the provider-scoped credential was issued. */
  readonly model?: string;
  readonly contextId?: AxisContextId;
  /** Present for credentials issued by current provider sessions. */
  readonly provider?: ProviderDriverKind;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: McpCapability,
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});

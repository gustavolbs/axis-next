import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderSkill } from "./server.ts";

export const ProviderMcpServerStatus = Schema.Literals([
  "connected",
  "authentication-required",
  "failed",
  "pending-approval",
  "disabled",
  "configured",
]);
export type ProviderMcpServerStatus = typeof ProviderMcpServerStatus.Type;

export const ProviderMcpServer = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: ProviderMcpServerStatus,
  enabled: Schema.Boolean,
  scope: Schema.optional(TrimmedNonEmptyString),
  transport: Schema.optional(TrimmedNonEmptyString),
  target: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderMcpServer = typeof ProviderMcpServer.Type;

export const ProviderCapabilityInventory = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  checkedAt: IsoDateTime,
  mcpServers: Schema.Array(ProviderMcpServer),
  skills: Schema.Array(ServerProviderSkill),
  mcpDiscoverySupported: Schema.Boolean,
});
export type ProviderCapabilityInventory = typeof ProviderCapabilityInventory.Type;

export const ProviderCapabilityInventoryInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type ProviderCapabilityInventoryInput = typeof ProviderCapabilityInventoryInput.Type;

export class ProviderCapabilityInventoryError extends Schema.TaggedErrorClass<ProviderCapabilityInventoryError>()(
  "ProviderCapabilityInventoryError",
  {
    instanceId: ProviderInstanceId,
    message: TrimmedNonEmptyString,
  },
) {}

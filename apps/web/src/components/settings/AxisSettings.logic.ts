import type { AxisContextCatalog, AxisContextId } from "@t3tools/contracts";

/** Removes one Company and every relationship that could retain access to it. */
export function removeAxisCompany(
  catalog: AxisContextCatalog,
  contextId: AxisContextId,
): AxisContextCatalog {
  const removedCapabilityIds = new Set(
    catalog.capabilities
      .filter((capability) => capability.ownerContextId === contextId)
      .map((capability) => capability.id),
  );
  return {
    contexts: catalog.contexts.filter((context) => context.id !== contextId),
    providerOwnerships: catalog.providerOwnerships.filter(
      (ownership) => ownership.contextId !== contextId,
    ),
    providerAccessGrants: catalog.providerAccessGrants.filter(
      (grant) => grant.ownerContextId !== contextId && grant.targetContextId !== contextId,
    ),
    capabilities: catalog.capabilities.filter(
      (capability) => capability.ownerContextId !== contextId,
    ),
    capabilityGrants: catalog.capabilityGrants.filter(
      (grant) =>
        grant.ownerContextId !== contextId &&
        grant.targetContextId !== contextId &&
        !removedCapabilityIds.has(grant.capabilityId),
    ),
  };
}

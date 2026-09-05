import {
  axisProviderInstanceLocatorKey,
  type AxisContextCatalog,
  type AxisContextId,
  type AxisProviderAccessGrantId,
  type AxisProviderInstanceLocator,
} from "@t3tools/contracts";

/** Removes one Company and every relationship that could retain access to it. */
export function removeAxisCompany(
  catalog: AxisContextCatalog,
  contextId: AxisContextId,
): AxisContextCatalog {
  const removedProviderKeys = new Set(
    catalog.providerOwnerships
      .filter((ownership) => ownership.contextId === contextId)
      .map((ownership) => axisProviderInstanceLocatorKey(ownership.provider)),
  );
  return {
    contexts: catalog.contexts.filter((context) => context.id !== contextId),
    providerOwnerships: catalog.providerOwnerships.filter(
      (ownership) => ownership.contextId !== contextId,
    ),
    providerAccessGrants: catalog.providerAccessGrants.filter(
      (grant) =>
        grant.ownerContextId !== contextId &&
        grant.targetContextId !== contextId &&
        !removedProviderKeys.has(axisProviderInstanceLocatorKey(grant.provider)),
    ),
    capabilities: catalog.capabilities.filter(
      (capability) => !removedProviderKeys.has(axisProviderInstanceLocatorKey(capability.provider)),
    ),
  };
}

/** Reassigns a provider and removes grants that depended on its previous owner. */
export function setAxisProviderOwner(
  catalog: AxisContextCatalog,
  provider: AxisProviderInstanceLocator,
  contextId: AxisContextId | null,
): AxisContextCatalog {
  const providerKey = axisProviderInstanceLocatorKey(provider);
  const currentOwner = catalog.providerOwnerships.find(
    (ownership) => axisProviderInstanceLocatorKey(ownership.provider) === providerKey,
  )?.contextId;
  if (currentOwner === contextId || (currentOwner === undefined && contextId === null)) {
    return catalog;
  }
  const providerAccessGrants = catalog.providerAccessGrants.filter(
    (grant) => axisProviderInstanceLocatorKey(grant.provider) !== providerKey,
  );
  return {
    ...catalog,
    providerOwnerships: [
      ...catalog.providerOwnerships.filter(
        (ownership) => axisProviderInstanceLocatorKey(ownership.provider) !== providerKey,
      ),
      ...(contextId === null ? [] : [{ contextId, provider }]),
    ],
    providerAccessGrants,
  };
}

/** Removes a Company's access to a Personal provider without changing that provider's capabilities. */
export function removeAxisProviderAccessGrant(
  catalog: AxisContextCatalog,
  grantId: AxisProviderAccessGrantId,
): AxisContextCatalog {
  return {
    ...catalog,
    providerAccessGrants: catalog.providerAccessGrants.filter((grant) => grant.id !== grantId),
  };
}

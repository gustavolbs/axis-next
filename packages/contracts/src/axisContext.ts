/**
 * Axis context and capability contracts.
 *
 * These records add product ownership and grants around environment-scoped T3
 * provider instances. They never replace provider, project, thread, or session
 * identities owned by T3.
 *
 * @module axisContext
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const AXIS_ENTITY_ID_MAX_CHARS = 128;
const AXIS_ENTITY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

const makeAxisEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.check(
    Schema.isMaxLength(AXIS_ENTITY_ID_MAX_CHARS),
    Schema.isPattern(AXIS_ENTITY_ID_PATTERN),
  ).pipe(Schema.brand(brand));

export const AxisContextId = makeAxisEntityId("AxisContextId");
export type AxisContextId = typeof AxisContextId.Type;

export const AxisProviderAccessGrantId = makeAxisEntityId("AxisProviderAccessGrantId");
export type AxisProviderAccessGrantId = typeof AxisProviderAccessGrantId.Type;

export const AxisCapabilityId = makeAxisEntityId("AxisCapabilityId");
export type AxisCapabilityId = typeof AxisCapabilityId.Type;

export const AxisCapabilityGrantId = makeAxisEntityId("AxisCapabilityGrantId");
export type AxisCapabilityGrantId = typeof AxisCapabilityGrantId.Type;

export const AxisContextKind = Schema.Literals(["personal", "company"]);
export type AxisContextKind = typeof AxisContextKind.Type;

export const AxisContext = Schema.Struct({
  id: AxisContextId,
  kind: AxisContextKind,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AxisContext = typeof AxisContext.Type;

/** A provider routing identity in the environment that owns its credentials. */
export const AxisProviderInstanceLocator = Schema.Struct({
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
});
export type AxisProviderInstanceLocator = typeof AxisProviderInstanceLocator.Type;

/** Assigns one T3 provider instance to its Personal or Company owner. */
export const AxisProviderOwnership = Schema.Struct({
  contextId: AxisContextId,
  provider: AxisProviderInstanceLocator,
});
export type AxisProviderOwnership = typeof AxisProviderOwnership.Type;

export const AxisGrantStatus = Schema.Literals(["active", "revoked"]);
export type AxisGrantStatus = typeof AxisGrantStatus.Type;

/**
 * Directional permission for a Company to select a Personal provider instance.
 * The grant does not transfer thread, session, memory, or capability data.
 */
export const AxisProviderAccessGrant = Schema.Struct({
  id: AxisProviderAccessGrantId,
  ownerContextId: AxisContextId,
  targetContextId: AxisContextId,
  provider: AxisProviderInstanceLocator,
  status: AxisGrantStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  revokedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type AxisProviderAccessGrant = typeof AxisProviderAccessGrant.Type;

export const AxisCapabilityKind = Schema.Literals(["mcp", "skill", "instructions", "preferences"]);
export type AxisCapabilityKind = typeof AxisCapabilityKind.Type;

/**
 * Management metadata for a capability. Type-specific configuration and
 * secrets remain behind the server/driver boundary and are not copied here.
 */
export const AxisCapability = Schema.Struct({
  id: AxisCapabilityId,
  ownerContextId: AxisContextId,
  kind: AxisCapabilityKind,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  description: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  portableToCompanies: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  compatibleDrivers: Schema.Array(ProviderDriverKind).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AxisCapability = typeof AxisCapability.Type;

/**
 * Grants one portable Personal capability to one Company and explicitly
 * names the provider instances on which it may be materialized.
 */
export const AxisCapabilityGrant = Schema.Struct({
  id: AxisCapabilityGrantId,
  capabilityId: AxisCapabilityId,
  ownerContextId: AxisContextId,
  targetContextId: AxisContextId,
  providerInstances: Schema.Array(AxisProviderInstanceLocator),
  status: AxisGrantStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  revokedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type AxisCapabilityGrant = typeof AxisCapabilityGrant.Type;

export const AxisContextCatalog = Schema.Struct({
  contexts: Schema.Array(AxisContext).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  providerOwnerships: Schema.Array(AxisProviderOwnership).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  providerAccessGrants: Schema.Array(AxisProviderAccessGrant).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  capabilities: Schema.Array(AxisCapability).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  capabilityGrants: Schema.Array(AxisCapabilityGrant).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type AxisContextCatalog = typeof AxisContextCatalog.Type;

export const AxisContextCatalogIssueCode = Schema.Literals([
  "personal_context_count",
  "duplicate_context_id",
  "unknown_context",
  "duplicate_provider_owner",
  "duplicate_grant_id",
  "provider_grant_owner_not_personal",
  "provider_grant_target_not_company",
  "provider_grant_owner_mismatch",
  "revocation_state_mismatch",
  "duplicate_capability_id",
  "unknown_capability",
  "capability_grant_owner_not_personal",
  "capability_grant_target_not_company",
  "capability_grant_owner_mismatch",
  "capability_not_portable",
  "capability_provider_not_accessible",
]);
export type AxisContextCatalogIssueCode = typeof AxisContextCatalogIssueCode.Type;

export interface AxisContextCatalogIssue {
  readonly code: AxisContextCatalogIssueCode;
  readonly path: string;
  readonly message: string;
}

export function axisProviderInstanceLocatorKey(provider: AxisProviderInstanceLocator): string {
  return `${provider.environmentId}\u0000${provider.instanceId}`;
}

function duplicateIds(
  ids: ReadonlyArray<string>,
  code: AxisContextCatalogIssueCode,
  path: string,
): ReadonlyArray<AxisContextCatalogIssue> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].map((id) => ({
    code,
    path,
    message: `Duplicate id '${id}'.`,
  }));
}

/** Relational validation run before a catalog is persisted or activated. */
export function validateAxisContextCatalog(
  catalog: AxisContextCatalog,
): ReadonlyArray<AxisContextCatalogIssue> {
  const issues: AxisContextCatalogIssue[] = [];
  const contexts = new Map(catalog.contexts.map((context) => [context.id, context]));
  const personalContexts = catalog.contexts.filter((context) => context.kind === "personal");

  if (personalContexts.length !== 1) {
    issues.push({
      code: "personal_context_count",
      path: "contexts",
      message: `Expected exactly one Personal context, received ${personalContexts.length}.`,
    });
  }
  issues.push(
    ...duplicateIds(
      catalog.contexts.map((context) => context.id),
      "duplicate_context_id",
      "contexts",
    ),
    ...duplicateIds(
      catalog.providerAccessGrants.map((grant) => grant.id),
      "duplicate_grant_id",
      "providerAccessGrants",
    ),
    ...duplicateIds(
      catalog.capabilities.map((capability) => capability.id),
      "duplicate_capability_id",
      "capabilities",
    ),
    ...duplicateIds(
      catalog.capabilityGrants.map((grant) => grant.id),
      "duplicate_grant_id",
      "capabilityGrants",
    ),
  );

  const providerOwners = new Map<string, AxisContextId>();
  for (const [index, ownership] of catalog.providerOwnerships.entries()) {
    const path = `providerOwnerships[${index}]`;
    if (!contexts.has(ownership.contextId)) {
      issues.push({ code: "unknown_context", path, message: "Provider owner does not exist." });
    }
    const key = axisProviderInstanceLocatorKey(ownership.provider);
    if (providerOwners.has(key)) {
      issues.push({
        code: "duplicate_provider_owner",
        path,
        message: "A provider instance must have exactly one context owner.",
      });
    } else {
      providerOwners.set(key, ownership.contextId);
    }
  }

  const activeProviderAccess = new Set<string>();
  for (const [index, grant] of catalog.providerAccessGrants.entries()) {
    const path = `providerAccessGrants[${index}]`;
    const owner = contexts.get(grant.ownerContextId);
    const target = contexts.get(grant.targetContextId);
    if ((grant.status === "revoked") !== (grant.revokedAt !== null)) {
      issues.push({
        code: "revocation_state_mismatch",
        path,
        message: "Revoked grants require revokedAt; active grants must not have it.",
      });
    }
    if (!owner || !target) {
      issues.push({ code: "unknown_context", path, message: "Grant context does not exist." });
      continue;
    }
    if (owner.kind !== "personal") {
      issues.push({
        code: "provider_grant_owner_not_personal",
        path,
        message: "Only Personal may grant a provider instance.",
      });
    }
    if (target.kind !== "company") {
      issues.push({
        code: "provider_grant_target_not_company",
        path,
        message: "A provider access grant must target a Company.",
      });
    }
    if (
      providerOwners.get(axisProviderInstanceLocatorKey(grant.provider)) !== grant.ownerContextId
    ) {
      issues.push({
        code: "provider_grant_owner_mismatch",
        path,
        message: "The grant owner does not own this provider instance.",
      });
    }
    if (grant.status === "active") {
      activeProviderAccess.add(
        `${grant.targetContextId}\u0000${axisProviderInstanceLocatorKey(grant.provider)}`,
      );
    }
  }

  const capabilities = new Map(
    catalog.capabilities.map((capability) => [capability.id, capability]),
  );
  for (const [index, capability] of catalog.capabilities.entries()) {
    if (!contexts.has(capability.ownerContextId)) {
      issues.push({
        code: "unknown_context",
        path: `capabilities[${index}]`,
        message: "Capability owner does not exist.",
      });
    }
  }

  for (const [index, grant] of catalog.capabilityGrants.entries()) {
    const path = `capabilityGrants[${index}]`;
    const owner = contexts.get(grant.ownerContextId);
    const target = contexts.get(grant.targetContextId);
    const capability = capabilities.get(grant.capabilityId);
    if ((grant.status === "revoked") !== (grant.revokedAt !== null)) {
      issues.push({
        code: "revocation_state_mismatch",
        path,
        message: "Revoked grants require revokedAt; active grants must not have it.",
      });
    }
    if (!owner || !target) {
      issues.push({ code: "unknown_context", path, message: "Grant context does not exist." });
      continue;
    }
    if (!capability) {
      issues.push({
        code: "unknown_capability",
        path,
        message: "Granted capability does not exist.",
      });
      continue;
    }
    if (owner.kind !== "personal") {
      issues.push({
        code: "capability_grant_owner_not_personal",
        path,
        message: "Only Personal capabilities may cross into a Company.",
      });
    }
    if (target.kind !== "company") {
      issues.push({
        code: "capability_grant_target_not_company",
        path,
        message: "A capability grant must target a Company.",
      });
    }
    if (capability.ownerContextId !== grant.ownerContextId) {
      issues.push({
        code: "capability_grant_owner_mismatch",
        path,
        message: "The grant owner does not own this capability.",
      });
    }
    if (!capability.portableToCompanies) {
      issues.push({
        code: "capability_not_portable",
        path,
        message: "This capability is not marked portable to Companies.",
      });
    }
    for (const provider of grant.providerInstances) {
      const providerKey = axisProviderInstanceLocatorKey(provider);
      const targetOwnsProvider = providerOwners.get(providerKey) === grant.targetContextId;
      const targetMayUseProvider = activeProviderAccess.has(
        `${grant.targetContextId}\u0000${providerKey}`,
      );
      if (!targetOwnsProvider && !targetMayUseProvider) {
        issues.push({
          code: "capability_provider_not_accessible",
          path,
          message: "The target Company cannot access a provider named by this capability grant.",
        });
      }
    }
  }

  return issues;
}

/** Provider instances a context may select, with no Company-to-Company flow. */
export function resolveAxisContextProviderInstances(
  catalog: AxisContextCatalog,
  contextId: AxisContextId,
): ReadonlyArray<AxisProviderInstanceLocator> {
  const providers = new Map<string, AxisProviderInstanceLocator>();
  for (const ownership of catalog.providerOwnerships) {
    if (ownership.contextId !== contextId) continue;
    providers.set(axisProviderInstanceLocatorKey(ownership.provider), ownership.provider);
  }
  for (const grant of catalog.providerAccessGrants) {
    if (grant.targetContextId !== contextId || grant.status !== "active") continue;
    providers.set(axisProviderInstanceLocatorKey(grant.provider), grant.provider);
  }
  return [...providers.values()];
}

function capabilitySupportsDriver(capability: AxisCapability, driver: ProviderDriverKind): boolean {
  return capability.compatibleDrivers.length === 0 || capability.compatibleDrivers.includes(driver);
}

/**
 * Computes the capabilities visible to one effective provider binding. The
 * result contains context-owned capabilities plus active, provider-specific
 * Personal grants and never infers access from provider ownership alone.
 */
export function resolveAxisContextCapabilities(input: {
  readonly catalog: AxisContextCatalog;
  readonly contextId: AxisContextId;
  readonly provider: AxisProviderInstanceLocator;
  readonly driver: ProviderDriverKind;
}): ReadonlyArray<AxisCapability> {
  const { catalog, contextId, provider, driver } = input;
  const providerKey = axisProviderInstanceLocatorKey(provider);
  const capabilities = new Map<AxisCapabilityId, AxisCapability>();

  for (const capability of catalog.capabilities) {
    if (
      capability.ownerContextId === contextId &&
      capability.enabled &&
      capabilitySupportsDriver(capability, driver)
    ) {
      capabilities.set(capability.id, capability);
    }
  }

  const capabilityById = new Map(
    catalog.capabilities.map((capability) => [capability.id, capability]),
  );
  for (const grant of catalog.capabilityGrants) {
    if (
      grant.targetContextId !== contextId ||
      grant.status !== "active" ||
      !grant.providerInstances.some(
        (candidate) => axisProviderInstanceLocatorKey(candidate) === providerKey,
      )
    ) {
      continue;
    }
    const capability = capabilityById.get(grant.capabilityId);
    if (
      !capability ||
      !capability.enabled ||
      !capability.portableToCompanies ||
      capability.ownerContextId !== grant.ownerContextId ||
      !capabilitySupportsDriver(capability, driver)
    ) {
      continue;
    }
    capabilities.set(capability.id, capability);
  }

  return [...capabilities.values()];
}

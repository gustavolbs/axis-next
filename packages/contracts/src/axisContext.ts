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

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
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

export const AxisWorkHubSourceId = makeAxisEntityId("AxisWorkHubSourceId");
export type AxisWorkHubSourceId = typeof AxisWorkHubSourceId.Type;

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
 * Provider-owned capabilities travel with the provider; context-owned thread,
 * session, memory, and product data do not.
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
 * Management metadata for a provider-owned capability. Type-specific
 * configuration and secrets remain behind the server/driver boundary.
 */
export const AxisCapability = Schema.Struct({
  id: AxisCapabilityId,
  provider: AxisProviderInstanceLocator,
  kind: AxisCapabilityKind,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  description: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  compatibleDrivers: Schema.Array(ProviderDriverKind).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AxisCapability = typeof AxisCapability.Type;

export const AXIS_WORK_HUB_DEFAULT_CACHE_TTL_SECONDS = 8 * 60 * 60;
const AxisWorkHubCacheTtlSeconds = PositiveInt.check(
  Schema.isGreaterThanOrEqualTo(AXIS_WORK_HUB_DEFAULT_CACHE_TTL_SECONDS),
);

export const AxisWorkHubCollectionPolicy = Schema.Struct({
  calendarLookbackDays: NonNegativeInt,
  calendarLookaheadDays: PositiveInt,
  assignedWorkItemsOnly: Schema.Boolean,
  directMessages: Schema.Boolean,
  mentions: Schema.Boolean,
  assignedIssueComments: Schema.Boolean,
});
export type AxisWorkHubCollectionPolicy = typeof AxisWorkHubCollectionPolicy.Type;

export const DEFAULT_AXIS_WORK_HUB_COLLECTION_POLICY: AxisWorkHubCollectionPolicy = {
  calendarLookbackDays: 14,
  calendarLookaheadDays: 90,
  assignedWorkItemsOnly: true,
  directMessages: true,
  mentions: true,
  assignedIssueComments: true,
};

/** One context-approved provider/MCP binding queried by Work Hub. */
export const AxisWorkHubSource = Schema.Struct({
  id: AxisWorkHubSourceId,
  contextId: AxisContextId,
  provider: AxisProviderInstanceLocator,
  capabilityId: AxisCapabilityId,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  cacheTtlSeconds: AxisWorkHubCacheTtlSeconds.pipe(
    Schema.withDecodingDefault(Effect.succeed(AXIS_WORK_HUB_DEFAULT_CACHE_TTL_SECONDS)),
  ),
  collectionPolicy: AxisWorkHubCollectionPolicy.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AXIS_WORK_HUB_COLLECTION_POLICY)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AxisWorkHubSource = typeof AxisWorkHubSource.Type;

export const AxisContextCatalog = Schema.Struct({
  contexts: Schema.Array(AxisContext).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  providerOwnerships: Schema.Array(AxisProviderOwnership).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  providerAccessGrants: Schema.Array(AxisProviderAccessGrant).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  capabilities: Schema.Array(AxisCapability).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  workHubSources: Schema.Array(AxisWorkHubSource).pipe(
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
  "capability_provider_unowned",
  "duplicate_work_hub_source_id",
  "duplicate_work_hub_source_binding",
  "work_hub_source_unknown_capability",
  "work_hub_source_not_mcp",
  "work_hub_source_provider_mismatch",
  "work_hub_source_provider_not_accessible",
]);
export type AxisContextCatalogIssueCode = typeof AxisContextCatalogIssueCode.Type;

export const AxisContextCatalogIssue = Schema.Struct({
  code: AxisContextCatalogIssueCode,
  path: Schema.String,
  message: Schema.String,
});
export type AxisContextCatalogIssue = typeof AxisContextCatalogIssue.Type;

/** Revisioned server snapshot used for optimistic concurrency across clients. */
export const AxisContextCatalogSnapshot = Schema.Struct({
  revision: NonNegativeInt,
  catalog: AxisContextCatalog,
  updatedAt: IsoDateTime,
});
export type AxisContextCatalogSnapshot = typeof AxisContextCatalogSnapshot.Type;

export const AxisContextCatalogReplaceInput = Schema.Struct({
  expectedRevision: NonNegativeInt,
  catalog: AxisContextCatalog,
});
export type AxisContextCatalogReplaceInput = typeof AxisContextCatalogReplaceInput.Type;

export class AxisContextCatalogValidationError extends Schema.TaggedErrorClass<AxisContextCatalogValidationError>()(
  "AxisContextCatalogValidationError",
  { issues: Schema.Array(AxisContextCatalogIssue) },
) {}

export class AxisContextCatalogConflictError extends Schema.TaggedErrorClass<AxisContextCatalogConflictError>()(
  "AxisContextCatalogConflictError",
  {
    expectedRevision: NonNegativeInt,
    actualRevision: NonNegativeInt,
  },
) {}

export class AxisContextCatalogPersistenceError extends Schema.TaggedErrorClass<AxisContextCatalogPersistenceError>()(
  "AxisContextCatalogPersistenceError",
  { operation: Schema.String },
) {}

export const AxisContextCatalogError = Schema.Union([
  AxisContextCatalogValidationError,
  AxisContextCatalogConflictError,
  AxisContextCatalogPersistenceError,
]);
export type AxisContextCatalogError = typeof AxisContextCatalogError.Type;

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
      catalog.workHubSources.map((source) => source.id),
      "duplicate_work_hub_source_id",
      "workHubSources",
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
  }

  for (const [index, capability] of catalog.capabilities.entries()) {
    if (!providerOwners.has(axisProviderInstanceLocatorKey(capability.provider))) {
      issues.push({
        code: "capability_provider_unowned",
        path: `capabilities[${index}]`,
        message: "A capability must belong to an owned provider instance.",
      });
    }
  }

  const capabilities = new Map(
    catalog.capabilities.map((capability) => [capability.id, capability]),
  );
  const workHubBindings = new Set<string>();
  for (const [index, source] of catalog.workHubSources.entries()) {
    const path = `workHubSources[${index}]`;
    const capability = capabilities.get(source.capabilityId);
    const providerKey = axisProviderInstanceLocatorKey(source.provider);
    const bindingKey = `${source.contextId}\u0000${providerKey}\u0000${source.capabilityId}`;
    if (workHubBindings.has(bindingKey)) {
      issues.push({
        code: "duplicate_work_hub_source_binding",
        path,
        message: "This context, provider, and MCP binding is already selected for Work Hub.",
      });
    }
    workHubBindings.add(bindingKey);
    if (!capability) {
      issues.push({
        code: "work_hub_source_unknown_capability",
        path,
        message: "The selected Work Hub MCP does not exist.",
      });
      continue;
    }
    if (capability.kind !== "mcp") {
      issues.push({
        code: "work_hub_source_not_mcp",
        path,
        message: "Only MCP capabilities can provide Work Hub data.",
      });
    }
    if (axisProviderInstanceLocatorKey(capability.provider) !== providerKey) {
      issues.push({
        code: "work_hub_source_provider_mismatch",
        path,
        message: "The selected MCP belongs to a different provider instance.",
      });
    }
    const providerAccessible = resolveAxisContextProviderInstances(catalog, source.contextId).some(
      (provider) => axisProviderInstanceLocatorKey(provider) === providerKey,
    );
    if (!providerAccessible) {
      issues.push({
        code: "work_hub_source_provider_not_accessible",
        path,
        message: "The selected context cannot access this provider instance.",
      });
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
 * Computes the capabilities attached to one provider when that provider is
 * accessible from the selected context.
 */
export function resolveAxisContextCapabilities(input: {
  readonly catalog: AxisContextCatalog;
  readonly contextId: AxisContextId;
  readonly provider: AxisProviderInstanceLocator;
  readonly driver: ProviderDriverKind;
}): ReadonlyArray<AxisCapability> {
  const { catalog, contextId, provider, driver } = input;
  const providerKey = axisProviderInstanceLocatorKey(provider);
  const accessible = resolveAxisContextProviderInstances(catalog, contextId).some(
    (candidate) => axisProviderInstanceLocatorKey(candidate) === providerKey,
  );
  if (!accessible) return [];
  return catalog.capabilities.filter(
    (capability) =>
      axisProviderInstanceLocatorKey(capability.provider) === providerKey &&
      capability.enabled &&
      capabilitySupportsDriver(capability, driver),
  );
}

import {
  AxisCapabilityId,
  AxisContextId,
  AxisProviderInstanceLocator,
  AxisTaskSource,
  AxisWorkHubCollectedItem as AxisWorkHubCollectedItemSchema,
  AxisWorkHubCollectionResult as AxisWorkHubCollectionResultSchema,
  EnvironmentId,
} from "@t3tools/contracts";
import type {
  AxisProviderInstanceLocator as AxisProviderInstanceLocatorType,
  AxisWorkHubCollectedItem,
  AxisWorkHubCollectionResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const MAX_CARDS_PER_READ = 500;
const MAX_LABELS_PER_CARD = 50;
const MAX_CURSOR_LENGTH = 4_096;
const MAX_ERROR_MESSAGE_LENGTH = 512;

export const AXIS_TRELLO_MAX_CARDS_PER_READ = MAX_CARDS_PER_READ;

export const AxisTrelloMappedStatus = Schema.Literals([
  "backlog",
  "todo",
  "in-progress",
  "blocked",
  "done",
]);
export type AxisTrelloMappedStatus = typeof AxisTrelloMappedStatus.Type;

const AxisTrelloTaskStatus = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("mapped"),
    native: Schema.NullOr(Schema.String),
    value: AxisTrelloMappedStatus,
  }),
  Schema.Struct({
    kind: Schema.Literal("unmapped"),
    native: Schema.NullOr(Schema.String),
  }),
]);
export type AxisTrelloTaskStatus = typeof AxisTrelloTaskStatus.Type;

const AxisTrelloTaskSource = Schema.Struct({
  source: AxisTaskSource,
  title: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  status: AxisTrelloTaskStatus,
  labels: Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_LABELS_PER_CARD)),
});
export type AxisTrelloTaskSource = typeof AxisTrelloTaskSource.Type;

export const AxisTrelloSourceSnapshot = Schema.Struct({
  items: Schema.Array(AxisTrelloTaskSource).check(Schema.isMaxLength(MAX_CARDS_PER_READ)),
  cursor: Schema.NullOr(Schema.String),
});
export type AxisTrelloSourceSnapshot = typeof AxisTrelloSourceSnapshot.Type;

const AxisTrelloNativeLabel = Schema.Struct({
  name: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256)),
});

const AxisTrelloNativeList = Schema.Union([
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  Schema.Struct({
    name: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  }),
]);

/** The small, provider-neutral subset expected from an authorized Trello MCP tool. */
export const AxisTrelloNativeCard = Schema.Struct({
  id: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256)),
  name: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(240)),
  url: Schema.optionalKey(
    Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(2_048)),
  ),
  labels: Schema.optionalKey(Schema.Array(AxisTrelloNativeLabel)),
  list: Schema.optionalKey(Schema.NullOr(AxisTrelloNativeList)),
  status: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(256)))),
});
export type AxisTrelloNativeCard = typeof AxisTrelloNativeCard.Type;

export const AxisTrelloNativePage = Schema.Struct({
  cards: Schema.Array(AxisTrelloNativeCard),
  cursor: Schema.NullOr(Schema.String),
});
export type AxisTrelloNativePage = typeof AxisTrelloNativePage.Type;

export interface AxisTrelloSourceConfig {
  /** The environment that owns the provider/MCP credential. */
  readonly environmentId: EnvironmentId;
  /** Axis context in which this source was granted. */
  readonly contextId: AxisContextId;
  /** The provider instance that owns the MCP capability. */
  readonly provider: AxisProviderInstanceLocatorType;
  /** The catalog capability being used; the MCP name alone is not authority. */
  readonly capabilityId: AxisCapabilityId;
  /** The exact MCP server name registered in that environment. */
  readonly mcpName: string;
  readonly boardId?: string;
  readonly listId?: string;
  /** Exact native list/status names to Axis statuses. Unknown values stay unmapped. */
  readonly statusMap: Readonly<Record<string, AxisTrelloMappedStatus>>;
  readonly maxCards?: number;
}

export interface AxisTrelloMcpReadInput {
  readonly boardId?: string;
  readonly listId?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export class AxisTrelloMcpReadError extends Schema.TaggedErrorClass<AxisTrelloMcpReadError>()(
  "AxisTrelloMcpReadError",
  { message: Schema.String },
) {}

/**
 * Identity attached to the already-authorized MCP handle. A boolean
 * authorization flag is intentionally insufficient: the handle must also
 * belong to the exact Axis context, provider instance, capability, and MCP
 * name requested by the source.
 */
export const AxisTrelloSourceIdentity = Schema.Struct({
  environmentId: EnvironmentId,
  contextId: AxisContextId,
  provider: AxisProviderInstanceLocator,
  capabilityId: AxisCapabilityId,
  mcpName: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
});
export type AxisTrelloSourceIdentity = typeof AxisTrelloSourceIdentity.Type;

/**
 * This binding is supplied by the provider runtime. It deliberately contains no token: the
 * environment-owned MCP configuration is the only place where Trello credentials live.
 */
export interface AxisTrelloMcpBinding {
  readonly identity: AxisTrelloSourceIdentity;
  readonly readCards: (
    input: AxisTrelloMcpReadInput,
  ) => Effect.Effect<unknown, AxisTrelloMcpReadError>;
}

export type AxisTrelloSourceErrorCode =
  | "configuration"
  | "authorization"
  | "transport"
  | "invalid-response"
  | "limit-exceeded";

export class AxisTrelloSourceError extends Schema.TaggedErrorClass<AxisTrelloSourceError>()(
  "AxisTrelloSourceError",
  {
    code: Schema.Literals([
      "configuration",
      "authorization",
      "transport",
      "invalid-response",
      "limit-exceeded",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const decodeCard = Schema.decodeUnknownSync(AxisTrelloNativeCard);
const decodePage = Schema.decodeUnknownEffect(AxisTrelloNativePage);
const decodeTaskSource = Schema.decodeUnknownSync(AxisTrelloTaskSource);
const decodeCollectedItem = Schema.decodeUnknownSync(AxisWorkHubCollectedItemSchema);
const decodeCollectionResult = Schema.decodeUnknownSync(AxisWorkHubCollectionResultSchema);
const isAxisTrelloSourceError = Schema.is(AxisTrelloSourceError);
const isAxisTrelloSourceIdentity = Schema.is(AxisTrelloSourceIdentity);

function errorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message
    .replace(
      /((?:authorization\s*:\s*bearer|bearer|token|api[-_ ]?key|secret|password)\s*[=:]?\s*)\S+/giu,
      "$1<redacted>",
    )
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function isAuthorizationFailure(cause: unknown): boolean {
  return /\b(?:401|403)\b|unauthori[sz]ed|forbidden|authentication\s+(?:is\s+)?required|(?:token|credential)s?\s+(?:has\s+)?(?:expired|invalid)/iu.test(
    errorMessage(cause),
  );
}

function sourceError(
  code: AxisTrelloSourceErrorCode,
  message: string,
  cause?: unknown,
): AxisTrelloSourceError {
  return new AxisTrelloSourceError({
    code,
    message,
    // Never retain a provider error object: MCP errors may contain secrets.
    ...(cause === undefined ? {} : { cause: errorMessage(cause) }),
  });
}

function validateConfig(config: AxisTrelloSourceConfig): AxisTrelloSourceError | undefined {
  if (config.mcpName.trim().length === 0) {
    return sourceError("configuration", "Trello MCP name must be configured.");
  }
  if (
    !isAxisTrelloSourceIdentity({
      environmentId: config.environmentId,
      contextId: config.contextId,
      provider: config.provider,
      capabilityId: config.capabilityId,
      mcpName: config.mcpName,
    })
  ) {
    return sourceError("configuration", "Trello source identity is invalid.");
  }
  if (config.provider.environmentId !== config.environmentId) {
    return sourceError(
      "configuration",
      "Trello provider must belong to the configured environment.",
    );
  }
  if (config.boardId !== undefined && config.boardId.trim().length === 0) {
    return sourceError("configuration", "Trello board ID must not be empty.");
  }
  if (config.listId !== undefined && config.listId.trim().length === 0) {
    return sourceError("configuration", "Trello list ID must not be empty.");
  }
  if (
    config.maxCards !== undefined &&
    (!Number.isInteger(config.maxCards) ||
      config.maxCards < 1 ||
      config.maxCards > MAX_CARDS_PER_READ)
  ) {
    return sourceError(
      "configuration",
      `Trello maxCards must be an integer between 1 and ${MAX_CARDS_PER_READ}.`,
    );
  }
  const seenNormalizedKeys = new Set<string>();
  for (const [nativeStatus, mappedStatus] of Object.entries(config.statusMap)) {
    if (nativeStatus.trim().length === 0 || !isAxisTrelloMappedStatus(mappedStatus)) {
      return sourceError("configuration", "Trello statusMap contains an invalid entry.");
    }
    const normalizedKey = nativeStatus.trim().toLocaleLowerCase();
    if (seenNormalizedKeys.has(normalizedKey)) {
      return sourceError(
        "configuration",
        `Trello statusMap contains duplicate entries that differ only by case or whitespace: '${nativeStatus}'.`,
      );
    }
    seenNormalizedKeys.add(normalizedKey);
  }
  return undefined;
}

const isAxisTrelloMappedStatus = Schema.is(AxisTrelloMappedStatus);

function sourceIdentity(config: AxisTrelloSourceConfig): AxisTrelloSourceIdentity {
  return {
    environmentId: config.environmentId,
    contextId: config.contextId,
    provider: config.provider,
    capabilityId: config.capabilityId,
    mcpName: config.mcpName,
  };
}

function bindingMatchesConfig(
  config: AxisTrelloSourceConfig,
  binding: AxisTrelloMcpBinding,
): boolean {
  if (!isAxisTrelloSourceIdentity(binding.identity)) return false;
  const expected = sourceIdentity(config);
  return (
    binding.identity.environmentId === expected.environmentId &&
    binding.identity.contextId === expected.contextId &&
    binding.identity.provider.environmentId === expected.provider.environmentId &&
    binding.identity.provider.instanceId === expected.provider.instanceId &&
    binding.identity.capabilityId === expected.capabilityId &&
    binding.identity.mcpName === expected.mcpName
  );
}

function nativeStatus(card: AxisTrelloNativeCard): string | null {
  const directStatus = card.status?.trim() || null;
  const listStatus =
    typeof card.list === "string"
      ? card.list
      : card.list === null || card.list === undefined
        ? null
        : card.list.name;
  const normalizedListStatus = listStatus?.trim() || null;
  if (
    directStatus !== null &&
    normalizedListStatus !== null &&
    directStatus !== normalizedListStatus
  ) {
    throw sourceError(
      "invalid-response",
      `Trello card '${card.id}' returned conflicting status and list values.`,
    );
  }
  return directStatus ?? normalizedListStatus;
}

export function normalizeAxisTrelloCard(
  input: AxisTrelloNativeCard,
  config: Pick<AxisTrelloSourceConfig, "statusMap">,
): AxisTrelloTaskSource {
  const card = decodeCard(input);
  const status = nativeStatus(card);
  const mappedStatus = status === null ? undefined : config.statusMap[status];
  const source = decodeTaskSource({
    source: {
      kind: "trello",
      cardId: card.id,
      ...(card.url === undefined ? {} : { url: card.url }),
    },
    title: card.name,
    status:
      mappedStatus === undefined
        ? { kind: "unmapped", native: status }
        : { kind: "mapped", native: status, value: mappedStatus },
    labels: (card.labels ?? []).map((label) => label.name),
  });
  return source;
}

/** Converts a Work Hub item back to the task-source shape used by task intake. */
export function toAxisTaskSource(
  input: AxisWorkHubCollectedItem,
  config: Pick<AxisTrelloSourceConfig, "statusMap">,
): AxisTrelloTaskSource {
  const item = decodeCollectedItem(input);
  const mapping = item.statusMapping;
  const native = (mapping?.native ?? item.status)?.trim() || null;
  const mapped =
    mapping?.kind === "unmapped"
      ? undefined
      : mapping?.kind === "mapped"
        ? mapping.value
        : native === null
          ? undefined
          : (config.statusMap[native] ?? (isAxisTrelloMappedStatus(native) ? native : undefined));
  return decodeTaskSource({
    source: {
      kind: "trello",
      cardId: item.nativeId,
      ...(item.deepLink === null ? {} : { url: item.deepLink }),
    },
    title: item.title,
    status:
      mapped === undefined
        ? { kind: "unmapped", native }
        : { kind: "mapped", native, value: mapped },
    labels: item.labels ?? [],
  });
}

/** Maps one native Trello card to the provider-neutral Work Hub contract. */
export function normalizeAxisTrelloCardToWorkHubItem(
  input: AxisTrelloNativeCard,
  config: Pick<AxisTrelloSourceConfig, "statusMap">,
): AxisWorkHubCollectedItem {
  const card = decodeCard(input);
  const status = nativeStatus(card);
  // Work Hub has one status string, so known native values are canonicalized here.
  // Unknown values remain untouched and are classified as `unmapped` by task intake.
  const mappedStatus = status === null ? null : (config.statusMap[status] ?? status);
  return decodeCollectedItem({
    kind: "assigned-work-item",
    view: "board",
    nativeId: card.id,
    title: card.name,
    summary: null,
    occurredAt: null,
    startsAt: null,
    endsAt: null,
    allDay: false,
    startDate: null,
    endDate: null,
    sourceTimeZone: null,
    calendar: null,
    organizer: null,
    participants: [],
    responseStatus: null,
    recurrence: null,
    cancelled: false,
    status: mappedStatus,
    statusMapping:
      status === null || config.statusMap[status] === undefined
        ? { kind: "unmapped" as const, native: status }
        : { kind: "mapped" as const, native: status, value: mappedStatus },
    assignee: null,
    priority: null,
    dueDate: null,
    labels: card.labels?.map((label) => label.name) ?? [],
    project: null,
    sourceUpdatedAt: null,
    deepLink: card.url ?? null,
    meetingLink: null,
    location: null,
  });
}

export interface AxisTrelloReadInput {
  readonly config: AxisTrelloSourceConfig;
  readonly binding: AxisTrelloMcpBinding;
  readonly cursor?: string | null;
}

/** Reads one bounded MCP page and returns the real Work Hub collection contract. */
export const readAxisTrelloSource = Effect.fn("readAxisTrelloSource")(function* (
  input: AxisTrelloReadInput,
) {
  const configError = validateConfig(input.config);
  if (configError !== undefined) return yield* Effect.fail(configError);

  if (!bindingMatchesConfig(input.config, input.binding)) {
    return yield* Effect.fail(
      sourceError(
        "authorization",
        "Trello MCP binding identity does not match the authorized Axis source.",
      ),
    );
  }
  const cursor = input.cursor ?? null;
  if (cursor !== null && cursor.length > MAX_CURSOR_LENGTH) {
    return yield* Effect.fail(
      sourceError("configuration", "Trello cursor exceeds the allowed length."),
    );
  }
  const limit = input.config.maxCards ?? MAX_CARDS_PER_READ;
  const page = yield* input.binding
    .readCards({
      ...(input.config.boardId === undefined ? {} : { boardId: input.config.boardId }),
      ...(input.config.listId === undefined ? {} : { listId: input.config.listId }),
      cursor,
      limit,
    })
    .pipe(
      Effect.mapError((cause) =>
        sourceError(
          isAuthorizationFailure(cause) ? "authorization" : "transport",
          isAuthorizationFailure(cause)
            ? "Trello MCP authorization failed."
            : `Trello MCP read failed${errorMessage(cause) ? `: ${errorMessage(cause)}` : "."}`,
          cause,
        ),
      ),
    );

  const decodedPage = yield* decodePage(page).pipe(
    Effect.mapError((cause) =>
      sourceError("invalid-response", "Trello MCP returned an invalid card page.", cause),
    ),
  );
  if (decodedPage.cards.length > limit) {
    return yield* Effect.fail(
      sourceError("limit-exceeded", `Trello MCP returned more than the requested ${limit} cards.`),
    );
  }
  if (decodedPage.cursor !== null && decodedPage.cursor.length > MAX_CURSOR_LENGTH) {
    return yield* Effect.fail(
      sourceError("invalid-response", "Trello MCP returned an oversized cursor."),
    );
  }

  const items: AxisWorkHubCollectedItem[] = [];
  const ids = new Set<string>();
  for (const card of decodedPage.cards) {
    if (ids.has(card.id)) {
      return yield* Effect.fail(
        sourceError("invalid-response", `Trello MCP returned duplicate card ID '${card.id}'.`),
      );
    }
    ids.add(card.id);
    if (card.labels !== undefined && card.labels.length > MAX_LABELS_PER_CARD) {
      return yield* Effect.fail(
        sourceError(
          "limit-exceeded",
          `Trello card '${card.id}' has more than ${MAX_LABELS_PER_CARD} labels.`,
        ),
      );
    }
    try {
      if (card.url !== undefined) {
        const url = new URL(card.url);
        if (
          (url.protocol !== "https:" && url.protocol !== "http:") ||
          url.username.length > 0 ||
          url.password.length > 0
        ) {
          return yield* Effect.fail(
            sourceError("invalid-response", `Trello card '${card.id}' returned an invalid URL.`),
          );
        }
      }
      items.push(normalizeAxisTrelloCardToWorkHubItem(card, input.config));
    } catch (cause) {
      if (isAxisTrelloSourceError(cause)) return yield* Effect.fail(cause);
      return yield* Effect.fail(
        sourceError("invalid-response", `Trello card '${card.id}' could not be normalized.`, cause),
      );
    }
  }

  const result = decodeCollectionResult({ items, cursor: decodedPage.cursor });
  return result;
});

export type AxisTrelloCollectionResult = AxisWorkHubCollectionResult;

export interface AxisTrelloSourceSession {
  readonly read: (
    input: AxisTrelloReadInput,
  ) => Effect.Effect<AxisTrelloCollectionResult, AxisTrelloSourceError>;
  readonly retry: (
    input: AxisTrelloReadInput,
  ) => Effect.Effect<AxisTrelloCollectionResult, AxisTrelloSourceError>;
  readonly getSnapshot: () => AxisTrelloCollectionResult | null;
}

/**
 * Keeps the last confirmed page in memory. A failed read, especially an auth
 * failure, never replaces it; callers must invoke retry explicitly.
 */
export function makeAxisTrelloSource(): AxisTrelloSourceSession {
  let snapshot: AxisTrelloCollectionResult | null = null;
  let snapshotConfigurationKey: string | null = null;
  let nextOperation = 0;
  let lastCommittedOperation = 0;

  const configurationKey = (input: AxisTrelloReadInput): string =>
    JSON.stringify({
      environmentId: input.config.environmentId,
      contextId: input.config.contextId,
      provider: input.config.provider,
      capabilityId: input.config.capabilityId,
      mcpName: input.config.mcpName,
      boardId: input.config.boardId ?? null,
      listId: input.config.listId ?? null,
      statusMap: Object.entries(input.config.statusMap).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
      maxCards: input.config.maxCards ?? null,
    });

  const read: AxisTrelloSourceSession["read"] = (input) =>
    Effect.suspend(() => {
      const operation = ++nextOperation;
      const key = configurationKey(input);
      if (snapshotConfigurationKey !== null && snapshotConfigurationKey !== key) {
        return Effect.fail(
          sourceError(
            "authorization",
            "Trello source snapshot identity does not match the requested source.",
          ),
        );
      }
      return readAxisTrelloSource(input).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (operation >= lastCommittedOperation) {
              snapshot = result;
              snapshotConfigurationKey = key;
              lastCommittedOperation = operation;
            }
          }),
        ),
      );
    });
  const retry: AxisTrelloSourceSession["retry"] = (input) =>
    Effect.suspend(() =>
      read({
        ...input,
        cursor: input.cursor === undefined ? (snapshot?.cursor ?? null) : input.cursor,
      }),
    );
  return {
    read,
    retry,
    getSnapshot: () => snapshot,
  };
}

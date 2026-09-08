/**
 * Axis scratch chat contracts.
 *
 * Legacy metadata retained to resolve old scratch URLs after migration.
 * Standalone conversations now use orchestration threads with projectId null.
 *
 * @module axisScratchChat
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { AxisContextId } from "./axisContext.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
} from "./orchestration.ts";

const ENTITY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export const AxisScratchChatId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(ENTITY_ID_PATTERN),
).pipe(Schema.brand("AxisScratchChatId"));
export type AxisScratchChatId = typeof AxisScratchChatId.Type;

export const AxisScratchChatMessageId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(ENTITY_ID_PATTERN),
).pipe(Schema.brand("AxisScratchChatMessageId"));
export type AxisScratchChatMessageId = typeof AxisScratchChatMessageId.Type;

export const AxisScratchChatRole = Schema.Literals(["user", "assistant", "system"]);
export type AxisScratchChatRole = typeof AxisScratchChatRole.Type;

/** A single message in a scratch chat. One row per line of the JSONL log. */
export const AxisScratchChatMessage = Schema.Struct({
  id: AxisScratchChatMessageId,
  chatId: AxisScratchChatId,
  role: AxisScratchChatRole,
  authorName: Schema.NullOr(TrimmedNonEmptyString),
  text: Schema.String,
  createdAt: IsoDateTime,
  /** Set on assistant messages: the backing Thread turn that produced it. */
  turnId: Schema.NullOr(TrimmedNonEmptyString),
  /** Logical turn index used by the UI to group user + assistant messages. */
  turnIndex: NonNegativeInt,
  /** True while the assistant is still streaming; flipped false on turn end. */
  streaming: Schema.optional(Schema.Boolean),
});
export type AxisScratchChatMessage = typeof AxisScratchChatMessage.Type;

/**
 * Server-owned metadata for a scratch chat. Persisted as a JSON blob in
 * `axis_scratch_chats.scratch_json` alongside indexed identifiers.
 */
export const AxisScratchChat = Schema.Struct({
  id: AxisScratchChatId,
  environmentId: EnvironmentId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  providerInstanceId: ProviderInstanceId,
  contextId: Schema.NullOr(AxisContextId),
  /** Only populated by legacy chats. New chats have no project. */
  backingProjectId: Schema.NullOr(ProjectId),
  /** Canonical orchestration thread id after importing legacy conversations. */
  backingThreadId: ThreadId,
  lastMessagePreview: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(280))),
  messageCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastMessageAt: Schema.NullOr(IsoDateTime),
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type AxisScratchChat = typeof AxisScratchChat.Type;

/** User-authored fields for creating a scratch chat. */
export const AxisScratchChatDraft = Schema.Struct({
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  providerInstanceId: ProviderInstanceId,
  contextId: Schema.optional(Schema.NullOr(AxisContextId)),
});
export type AxisScratchChatDraft = typeof AxisScratchChatDraft.Type;

/** Patchable metadata. Extensible without bumping the archive RPC. */
export const AxisScratchChatPatch = Schema.Struct({
  id: AxisScratchChatId,
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type AxisScratchChatPatch = typeof AxisScratchChatPatch.Type;

// ----- RPC payloads -----

export const AxisScratchChatListInput = Schema.Struct({
  includeArchived: Schema.optional(Schema.Boolean),
});
export type AxisScratchChatListInput = typeof AxisScratchChatListInput.Type;

export const AxisScratchChatGetInput = Schema.Struct({
  chatId: AxisScratchChatId,
  afterMessageId: Schema.optional(AxisScratchChatMessageId),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(500))),
});
export type AxisScratchChatGetInput = typeof AxisScratchChatGetInput.Type;

export const AxisScratchChatCreateInput = Schema.Struct({
  draft: AxisScratchChatDraft,
});
export type AxisScratchChatCreateInput = typeof AxisScratchChatCreateInput.Type;

export const AxisScratchChatPatchInput = Schema.Struct({
  patch: AxisScratchChatPatch,
});
export type AxisScratchChatPatchInput = typeof AxisScratchChatPatchInput.Type;

export const AxisScratchChatArchiveInput = Schema.Struct({
  chatId: AxisScratchChatId,
  archived: Schema.optional(Schema.Boolean),
});
export type AxisScratchChatArchiveInput = typeof AxisScratchChatArchiveInput.Type;

export const AxisScratchChatRemoveInput = Schema.Struct({
  chatId: AxisScratchChatId,
});
export type AxisScratchChatRemoveInput = typeof AxisScratchChatRemoveInput.Type;

export const AxisScratchChatSendMessageInput = Schema.Struct({
  chatId: AxisScratchChatId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
  /** Optional: server validates against the chat's pinned provider. */
  modelSelection: Schema.optional(ModelSelection),
});
export type AxisScratchChatSendMessageInput = typeof AxisScratchChatSendMessageInput.Type;

export const AxisScratchChatSubscribeInput = Schema.Struct({
  chatId: AxisScratchChatId,
  afterMessageId: Schema.optional(AxisScratchChatMessageId),
});
export type AxisScratchChatSubscribeInput = typeof AxisScratchChatSubscribeInput.Type;

// ----- Tagged errors -----

export class AxisScratchChatNotFoundError extends Schema.TaggedErrorClass<AxisScratchChatNotFoundError>()(
  "AxisScratchChatNotFoundError",
  { id: AxisScratchChatId },
) {}

export class AxisScratchChatValidationError extends Schema.TaggedErrorClass<AxisScratchChatValidationError>()(
  "AxisScratchChatValidationError",
  { message: Schema.String },
) {}

export class AxisScratchChatPersistenceError extends Schema.TaggedErrorClass<AxisScratchChatPersistenceError>()(
  "AxisScratchChatPersistenceError",
  { operation: Schema.String },
) {}

export class AxisScratchChatProviderUnavailableError extends Schema.TaggedErrorClass<AxisScratchChatProviderUnavailableError>()(
  "AxisScratchChatProviderUnavailableError",
  {
    instanceId: ProviderInstanceId,
    message: Schema.String,
  },
) {}

export const AxisScratchChatError = Schema.Union([
  AxisScratchChatNotFoundError,
  AxisScratchChatValidationError,
  AxisScratchChatPersistenceError,
  AxisScratchChatProviderUnavailableError,
]);
export type AxisScratchChatError = typeof AxisScratchChatError.Type;

// ----- Stream events -----

export const AxisScratchChatTurnState = Schema.Literals([
  "queued",
  "running",
  "completed",
  "error",
  "interrupted",
]);
export type AxisScratchChatTurnState = typeof AxisScratchChatTurnState.Type;

export const AxisScratchChatSnapshot = Schema.Struct({
  chat: AxisScratchChat,
  messages: Schema.Array(AxisScratchChatMessage),
  /** id of the last message in `messages`; resume cursor for live events. */
  cursor: Schema.NullOr(AxisScratchChatMessageId),
  turnState: Schema.optional(AxisScratchChatTurnState),
});
export type AxisScratchChatSnapshot = typeof AxisScratchChatSnapshot.Type;

export const AxisScratchChatStreamEvent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("synchronized") }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: AxisScratchChatSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("message-appended"),
    message: AxisScratchChatMessage,
  }),
  Schema.Struct({
    kind: Schema.Literal("message-delta"),
    messageId: AxisScratchChatMessageId,
    delta: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("chat-patched"),
    chat: AxisScratchChat,
  }),
  Schema.Struct({
    kind: Schema.Literal("chat-archived"),
    chat: AxisScratchChat,
  }),
  Schema.Struct({
    kind: Schema.Literal("chat-removed"),
    chatId: AxisScratchChatId,
  }),
  Schema.Struct({
    kind: Schema.Literal("turn-state"),
    threadId: ThreadId,
    turnId: Schema.NullOr(TrimmedNonEmptyString),
    state: AxisScratchChatTurnState,
  }),
]);
export type AxisScratchChatStreamEvent = typeof AxisScratchChatStreamEvent.Type;

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AxisScratchChat,
  AxisScratchChatId,
  type AxisScratchChatError,
  AxisScratchChatNotFoundError,
  AxisScratchChatPatch,
  AxisScratchChatPersistenceError,
} from "@t3tools/contracts";

type ChatRow = {
  readonly id: unknown;
  readonly environmentId: unknown;
  readonly scratchJson: unknown;
  readonly backingProjectId: unknown;
  readonly backingThreadId: unknown;
  readonly archivedAt: unknown;
  readonly lastMessageAt: unknown;
  readonly updatedAt: unknown;
};

const decodeChatJson = Schema.decodeUnknownEffect(Schema.fromJsonString(AxisScratchChat));
const encodeChatJson = Schema.encodeEffect(Schema.fromJsonString(AxisScratchChat));

const persistenceError = (operation: string) => () =>
  new AxisScratchChatPersistenceError({ operation });

export class AxisScratchChatStore extends Context.Service<
  AxisScratchChatStore,
  {
    readonly list: (input: {
      readonly environmentId: string;
      readonly includeArchived: boolean;
    }) => Effect.Effect<ReadonlyArray<AxisScratchChat>, AxisScratchChatPersistenceError>;
    readonly get: (id: AxisScratchChatId) => Effect.Effect<AxisScratchChat, AxisScratchChatError>;
    readonly create: (
      chat: AxisScratchChat,
    ) => Effect.Effect<AxisScratchChat, AxisScratchChatError>;
    readonly patch: (
      patch: AxisScratchChatPatch,
      updatedAt: string,
    ) => Effect.Effect<AxisScratchChat, AxisScratchChatError>;
    readonly archive: (
      id: AxisScratchChatId,
      archivedAt: string | null,
    ) => Effect.Effect<AxisScratchChat, AxisScratchChatError>;
    readonly remove: (id: AxisScratchChatId) => Effect.Effect<void, AxisScratchChatError>;
    readonly setLastMessage: (input: {
      readonly id: AxisScratchChatId;
      readonly lastMessagePreview: string;
      readonly lastMessageAt: string;
      readonly messageCount: number;
      readonly updatedAt: string;
    }) => Effect.Effect<void, AxisScratchChatError>;
  }
>()("t3/axis/scratch/AxisScratchChatStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readRows = (id: AxisScratchChatId) =>
    sql<ChatRow>`
      SELECT
        id AS "id",
        environment_id AS "environmentId",
        scratch_json AS "scratchJson",
        backing_project_id AS "backingProjectId",
        backing_thread_id AS "backingThreadId",
        archived_at AS "archivedAt",
        last_message_at AS "lastMessageAt",
        updated_at AS "updatedAt"
      FROM axis_scratch_chats
      WHERE id = ${id}
    `.pipe(Effect.mapError(persistenceError("read scratch chat row")));

  const list: AxisScratchChatStore["Service"]["list"] = ({ environmentId, includeArchived }) =>
    sql<{ readonly scratchJson: unknown }>`
      SELECT scratch_json AS "scratchJson"
      FROM axis_scratch_chats
      WHERE environment_id = ${environmentId}
        ${includeArchived ? sql`` : sql`AND archived_at IS NULL`}
      ORDER BY archived_at IS NOT NULL, updated_at DESC
    `.pipe(
      Effect.mapError(persistenceError("list scratch chats")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => decodeChatJson(row.scratchJson), { concurrency: 8 }).pipe(
          Effect.mapError(persistenceError("decode scratch chat list")),
        ),
      ),
    );

  const get: AxisScratchChatStore["Service"]["get"] = (id) =>
    readRows(id).pipe(
      Effect.mapError(persistenceError("read scratch chat")),
      Effect.flatMap((rows): Effect.Effect<AxisScratchChat, AxisScratchChatError> =>
        rows[0] === undefined
          ? Effect.fail(new AxisScratchChatNotFoundError({ id }))
          : decodeChatJson(rows[0].scratchJson).pipe(
              Effect.mapError(persistenceError("decode scratch chat")),
            ),
      ),
    );

  const create: AxisScratchChatStore["Service"]["create"] = (chat) =>
    encodeChatJson(chat).pipe(
      Effect.mapError(persistenceError("encode scratch chat")),
      Effect.flatMap((json) =>
        sql`
        INSERT INTO axis_scratch_chats (
          id, environment_id, scratch_json, backing_project_id, backing_thread_id,
          archived_at, last_message_at, updated_at
        )
        VALUES (
          ${chat.id}, ${chat.environmentId}, ${json},
          ${chat.backingProjectId}, ${chat.backingThreadId},
          ${chat.archivedAt}, ${chat.lastMessageAt}, ${chat.updatedAt}
        )
      `.pipe(
          Effect.mapError(persistenceError("insert scratch chat")),
          Effect.map(() => chat),
        ),
      ),
    );

  const patch: AxisScratchChatStore["Service"]["patch"] = (patch, updatedAt) =>
    get(patch.id).pipe(
      Effect.flatMap((current) => {
        const next: AxisScratchChat = {
          ...current,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          updatedAt,
        };
        return encodeChatJson(next).pipe(
          Effect.mapError(persistenceError("encode patched scratch chat")),
          Effect.flatMap((json) =>
            sql`
              UPDATE axis_scratch_chats
              SET scratch_json = ${json}, updated_at = ${updatedAt}
              WHERE id = ${patch.id}
            `.pipe(
              Effect.mapError(persistenceError("update scratch chat")),
              Effect.map(() => next),
            ),
          ),
        );
      }),
    );

  const archive: AxisScratchChatStore["Service"]["archive"] = (id, archivedAt) => {
    const updatedAt = DateTime.formatIso(DateTime.nowUnsafe());
    return get(id).pipe(
      Effect.flatMap((current) => {
        const next: AxisScratchChat = { ...current, archivedAt, updatedAt };
        return encodeChatJson(next).pipe(
          Effect.mapError(persistenceError("encode archived scratch chat")),
          Effect.flatMap((json) =>
            sql`
              UPDATE axis_scratch_chats
              SET scratch_json = ${json}, archived_at = ${archivedAt}, updated_at = ${updatedAt}
              WHERE id = ${id}
            `.pipe(
              Effect.mapError(persistenceError("archive scratch chat")),
              Effect.map(() => next),
            ),
          ),
        );
      }),
    );
  };

  const remove: AxisScratchChatStore["Service"]["remove"] = (id) =>
    get(id).pipe(
      Effect.flatMap(() =>
        sql`DELETE FROM axis_scratch_chats WHERE id = ${id}`.pipe(
          Effect.mapError(persistenceError("delete scratch chat")),
          Effect.asVoid,
        ),
      ),
    );

  const setLastMessage: AxisScratchChatStore["Service"]["setLastMessage"] = ({
    id,
    lastMessagePreview,
    lastMessageAt,
    messageCount,
    updatedAt,
  }) =>
    readRows(id).pipe(
      Effect.mapError(persistenceError("read scratch chat for last message")),
      Effect.flatMap((rows): Effect.Effect<AxisScratchChat, AxisScratchChatError> =>
        rows[0] === undefined
          ? Effect.fail(new AxisScratchChatNotFoundError({ id }))
          : decodeChatJson(rows[0].scratchJson).pipe(
              Effect.mapError(persistenceError("decode scratch chat")),
            ),
      ),
      Effect.flatMap((current) => {
        const next: AxisScratchChat = {
          ...current,
          lastMessagePreview,
          lastMessageAt,
          messageCount,
          updatedAt,
        };
        return encodeChatJson(next).pipe(
          Effect.mapError(persistenceError("encode scratch chat last message")),
          Effect.flatMap((json) =>
            sql`
              UPDATE axis_scratch_chats
              SET scratch_json = ${json},
                  last_message_at = ${lastMessageAt},
                  updated_at = ${updatedAt}
              WHERE id = ${id}
            `.pipe(
              Effect.mapError(persistenceError("update scratch chat last message")),
              Effect.asVoid,
            ),
          ),
        );
      }),
    );

  return {
    list,
    get,
    create,
    patch,
    archive,
    remove,
    setLastMessage,
  } satisfies AxisScratchChatStore["Service"];
});

export const layer = Layer.effect(AxisScratchChatStore, make);

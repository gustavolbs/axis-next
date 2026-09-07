import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  AxisScratchChatId,
  AxisScratchChatMessage,
  AxisScratchChatMessageId,
  AxisScratchChatPersistenceError,
} from "@t3tools/contracts";

import * as ServerConfig from "../../config.ts";
import { writeFileStringAtomically } from "../../atomicWrite.ts";

const SCRATCH_DIRNAME = "scratch";

const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(AxisScratchChatMessage));
const encodeLine = Schema.encodeEffect(Schema.fromJsonString(AxisScratchChatMessage));

const persistenceError = (operation: string) => () =>
  new AxisScratchChatPersistenceError({ operation });

export class AxisScratchChatMessageLog extends Context.Service<
  AxisScratchChatMessageLog,
  {
    readonly append: (
      chatId: AxisScratchChatId,
      message: AxisScratchChatMessage,
    ) => Effect.Effect<void, AxisScratchChatPersistenceError>;
    readonly readAll: (
      chatId: AxisScratchChatId,
    ) => Effect.Effect<ReadonlyArray<AxisScratchChatMessage>, AxisScratchChatPersistenceError>;
    readonly readTail: (input: {
      readonly chatId: AxisScratchChatId;
      readonly afterMessageId?: AxisScratchChatMessageId;
      readonly limit?: number;
    }) => Effect.Effect<
      {
        readonly messages: ReadonlyArray<AxisScratchChatMessage>;
        readonly headId: AxisScratchChatMessageId | null;
      },
      AxisScratchChatPersistenceError
    >;
    readonly rewrite: (input: {
      readonly chatId: AxisScratchChatId;
      readonly messages: ReadonlyArray<AxisScratchChatMessage>;
    }) => Effect.Effect<void, AxisScratchChatPersistenceError>;
    readonly remove: (
      chatId: AxisScratchChatId,
    ) => Effect.Effect<void, AxisScratchChatPersistenceError>;
  }
>()("t3/axis/scratch/AxisScratchChatMessageLog") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;

  const scratchDir = path.join(config.stateDir, SCRATCH_DIRNAME);
  yield* fs
    .makeDirectory(scratchDir, { recursive: true })
    .pipe(Effect.mapError(persistenceError("ensure scratch dir")));

  const fileFor = (chatId: AxisScratchChatId) => path.join(scratchDir, `${chatId}.jsonl`);

  const serialize = (messages: ReadonlyArray<AxisScratchChatMessage>) =>
    Effect.forEach(messages, (m) => encodeLine(m), { concurrency: 8 }).pipe(
      Effect.map((lines) => (lines.length > 0 ? `${lines.join("\n")}\n` : "")),
      Effect.mapError(persistenceError("encode messages")),
    );

  const writeAtomic = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.mapError(persistenceError("write scratch chat log")),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const readAllImpl = (chatId: AxisScratchChatId) =>
    Effect.gen(function* () {
      const filePath = fileFor(chatId);
      const exists = yield* fs
        .exists(filePath)
        .pipe(Effect.mapError(persistenceError("stat scratch chat log")));
      if (!exists) return [] as ReadonlyArray<AxisScratchChatMessage>;
      const text = yield* fs
        .readFileString(filePath)
        .pipe(Effect.mapError(persistenceError("read scratch chat log")));
      const lines = text.split("\n").filter((line) => line.length > 0);
      return yield* Effect.forEach(lines, (line) => decodeLine(line), { concurrency: 8 }).pipe(
        Effect.mapError(persistenceError("decode scratch chat log")),
      );
    }).pipe(Effect.provideService(FileSystem.FileSystem, fs));

  const append: AxisScratchChatMessageLog["Service"]["append"] = (chatId, message) =>
    readAllImpl(chatId).pipe(
      Effect.flatMap((existing) => serialize([...existing, message])),
      Effect.flatMap((contents) => writeAtomic(fileFor(chatId), contents)),
    );

  const readAll: AxisScratchChatMessageLog["Service"]["readAll"] = (chatId) => readAllImpl(chatId);

  const readTail: AxisScratchChatMessageLog["Service"]["readTail"] = ({
    chatId,
    afterMessageId,
    limit,
  }) =>
    Effect.gen(function* () {
      const all = yield* readAllImpl(chatId);
      let start = 0;
      if (afterMessageId !== undefined) {
        const idx = all.findIndex((m) => m.id === afterMessageId);
        start = idx >= 0 ? idx + 1 : all.length;
      }
      const afterCursor = all.slice(start);
      const slice =
        limit !== undefined && afterCursor.length > limit
          ? afterCursor.slice(afterCursor.length - limit)
          : afterCursor;
      const head = slice.length > 0 ? slice[slice.length - 1]!.id : null;
      return { messages: slice, headId: head };
    });

  const rewrite: AxisScratchChatMessageLog["Service"]["rewrite"] = ({ chatId, messages }) =>
    serialize(messages).pipe(Effect.flatMap((contents) => writeAtomic(fileFor(chatId), contents)));

  const remove: AxisScratchChatMessageLog["Service"]["remove"] = (chatId) =>
    fs
      .remove(fileFor(chatId), { force: true })
      .pipe(
        Effect.mapError(persistenceError("remove scratch chat log")),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );

  return {
    append,
    readAll,
    readTail,
    rewrite,
    remove,
  } satisfies AxisScratchChatMessageLog["Service"];
});

export const layer = Layer.effect(AxisScratchChatMessageLog, make);

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  AxisScratchChatId,
  AxisScratchChatMessage,
  AxisScratchChatMessageId,
} from "@t3tools/contracts";
import * as ServerConfig from "../../config.ts";
import {
  AxisScratchChatMessageLog,
  layer as messageLogLayer,
} from "./AxisScratchChatMessageLog.ts";

const message = (
  id: string,
  chatId: string,
  text: string,
  turnIndex: number,
): AxisScratchChatMessage => ({
  id: AxisScratchChatMessageId.make(id),
  chatId: AxisScratchChatId.make(chatId),
  role: "user",
  authorName: null,
  text,
  createdAt: "2026-09-07T00:00:00.000Z",
  turnId: null,
  turnIndex,
  streaming: false,
});

const layer = it.layer(
  Layer.provide(
    Layer.provide(messageLogLayer, ServerConfig.layerTest(process.cwd(), process.cwd())),
    NodeServices.layer,
  ),
);

let logCounter = 0;
const freshChatId = (suffix: string) =>
  AxisScratchChatId.make(`scratch-log-${++logCounter}-${suffix}`);

layer("AxisScratchChatMessageLog", (it) => {
  it.effect("appends messages, reads them back, and tails from a cursor", () =>
    Effect.gen(function* () {
      const log = yield* AxisScratchChatMessageLog;
      const chatId = freshChatId("1");
      yield* log.remove(chatId).pipe(Effect.orElseSucceed(() => undefined));
      const ids: Array<AxisScratchChatMessageId> = [];

      for (let i = 0; i < 5; i++) {
        const m = message(`msg-${i}`, chatId, `text ${i}`, i);
        ids.push(m.id);
        yield* log.append(chatId, m);
      }

      const all = yield* log.readAll(chatId);
      assert.equal(all.length, 5);
      assert.equal(all[0]?.text, "text 0");
      assert.equal(all[4]?.text, "text 4");

      const tailed = yield* log.readTail({ chatId, limit: 2 });
      assert.equal(tailed.messages.length, 2);
      assert.equal(tailed.messages[0]?.text, "text 3");
      assert.equal(tailed.messages[1]?.text, "text 4");
      assert.equal(tailed.headId, ids[4]);

      const fromCursor = yield* log.readTail({
        chatId,
        afterMessageId: ids[1] ?? ids[0]!,
        limit: 10,
      });
      assert.equal(fromCursor.messages.length, 3);
      assert.equal(fromCursor.messages[0]?.id, ids[2]);
      assert.equal(fromCursor.headId, ids[4]);

      yield* log.remove(chatId);
    }),
  );

  it.effect("rewrites the log atomically and removes it", () =>
    Effect.gen(function* () {
      const log = yield* AxisScratchChatMessageLog;
      const chatId = freshChatId("2");
      yield* log.remove(chatId).pipe(Effect.orElseSucceed(() => undefined));

      const original = [message("a", chatId, "first", 0), message("b", chatId, "second", 1)];
      for (const m of original) yield* log.append(chatId, m);

      const replacement = [message("c", chatId, "rewritten", 0)];
      yield* log.rewrite({ chatId, messages: replacement });

      const reread = yield* log.readAll(chatId);
      assert.equal(reread.length, 1);
      assert.equal(reread[0]?.text, "rewritten");

      yield* log.remove(chatId);
      const afterRemove = yield* log.readAll(chatId);
      assert.deepEqual(afterRemove, []);
    }),
  );
});

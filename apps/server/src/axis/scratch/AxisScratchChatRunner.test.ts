import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AxisScratchChatStore } from "./AxisScratchChatStore.ts";
import { AxisScratchChatMessageLog } from "./AxisScratchChatMessageLog.ts";
import { make } from "./AxisScratchChatRunner.ts";

it.effect("rejects legacy writes after conversations move to orchestration", () =>
  Effect.gen(function* () {
    const runner = yield* make;
    for (const operation of [
      runner.patch,
      runner.archive,
      runner.remove,
      runner.interrupt,
      runner.sendMessage,
      runner.create,
    ]) {
      // All retired operations fail before accessing metadata, files or providers.
      const result = yield* operation().pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(AxisScratchChatStore)({}),
        Layer.mock(AxisScratchChatMessageLog)({}),
      ),
    ),
  ),
);

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { AxisScheduledActivity, AxisScheduledActivityRun, ThreadId } from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AxisScheduledActivityStore, layer as storeLayer } from "./AxisScheduledActivityStore.ts";

const testLayer = Layer.merge(
  SqlitePersistenceMemory,
  storeLayer.pipe(Layer.provide(SqlitePersistenceMemory)),
);
const layer = it.layer(testLayer);
const activity = Schema.decodeUnknownSync(AxisScheduledActivity)({
  id: "daily_sync",
  name: "Daily sync",
  contextId: "personal",
  action: { kind: "workHubSync", sourceIds: ["calendar"] },
  schedule: { kind: "interval", everyMinutes: 480, anchorAt: "2026-09-05T08:00:00.000Z" },
  enabled: true,
  nextRunAt: "2026-09-05T08:00:00.000Z",
  lastRunAt: null,
  lastRunStatus: null,
  lastRunMessage: null,
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
});
const storedRun = Schema.decodeUnknownSync(AxisScheduledActivityRun)({
  id: "run_1",
  activityId: activity.id,
  trigger: "scheduled",
  status: "succeeded",
  startedAt: "2026-09-05T08:00:00.000Z",
  finishedAt: "2026-09-05T08:00:01.000Z",
  message: "1 source synced; 0 failed or skipped.",
  sourceResults: [{ sourceId: "calendar", status: "succeeded", itemCount: 2, message: null }],
});
const interruptedRun = Schema.decodeUnknownSync(AxisScheduledActivityRun)({
  ...storedRun,
  id: "run_interrupted",
  status: "running",
  finishedAt: null,
  message: null,
});
const openAgentRun = Schema.decodeUnknownSync(AxisScheduledActivityRun)({
  ...interruptedRun,
  id: "run_agent",
  threadId: ThreadId.make("scheduled-thread"),
});

layer("AxisScheduledActivityStore", (it) => {
  it.effect("persists activities, due queries, and run history", () =>
    Effect.gen(function* () {
      const store = yield* AxisScheduledActivityStore;
      yield* store.create(activity);
      assert.deepEqual(yield* store.listDue("2026-09-05T07:59:59.000Z"), []);
      assert.equal((yield* store.listDue("2026-09-05T08:00:00.000Z"))[0]?.id, activity.id);

      yield* store.saveRun(storedRun);
      assert.equal((yield* store.listRuns(activity.id, 20))[0]?.status, "succeeded");

      yield* store.saveRun(interruptedRun);
      yield* store.saveRun(openAgentRun);
      assert.deepEqual(
        (yield* store.listOpenAgentRuns).map((run) => run.id),
        [openAgentRun.id],
      );
      assert.equal(yield* store.recoverInterruptedRuns("2026-09-05T09:00:00.000Z"), 1);
      const recovered = (yield* store.listRuns(activity.id, 20)).find(
        (run) => run.id === interruptedRun.id,
      );
      assert.equal(recovered?.status, "failed");
      assert.equal(recovered?.finishedAt, "2026-09-05T09:00:00.000Z");
      assert.match(recovered?.message ?? "", /server stopped/);
      assert.equal((yield* store.listOpenAgentRuns)[0]?.status, "running");

      yield* store.update({ ...activity, enabled: false });
      assert.equal((yield* store.get(activity.id)).enabled, false);
      yield* store.remove(activity.id);
      assert.equal((yield* store.list).length, 0);
      assert.equal((yield* store.listRuns(activity.id, 20)).length, 0);
    }),
  );
});

import { CommandId, ThreadId, MessageId, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

it.effect("creates and starts a normal conversation without creating a project", () =>
  Effect.gen(function* () {
    const now = "2026-09-07T00:00:00.000Z";
    const threadId = ThreadId.make("standalone");
    const created = yield* decideOrchestrationCommand({
      readModel: createEmptyReadModel(now),
      command: {
        type: "thread.create",
        commandId: CommandId.make("create-chat"),
        threadId,
        projectId: null,
        title: "New thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "auto" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      },
    });
    const event = Array.isArray(created) ? created[0] : created;
    const readModel = yield* projectEvent(createEmptyReadModel(now), { ...event, sequence: 1 });
    expect(readModel.projects).toEqual([]);
    expect(readModel.threads[0]?.projectId).toBeNull();
    const started = yield* decideOrchestrationCommand({
      readModel,
      command: {
        type: "thread.turn.start",
        commandId: CommandId.make("send-chat"),
        threadId,
        message: {
          messageId: MessageId.make("message"),
          role: "user",
          text: "Hello",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: now,
      },
    });
    const events = Array.isArray(started) ? started : [started];
    expect(events.map((entry) => entry.type)).toContain("thread.turn-start-requested");
    expect(events.some((entry) => entry.aggregateKind === "project")).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

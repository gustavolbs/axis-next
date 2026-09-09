import {
  ApprovalRequestId,
  CommandId,
  ThreadId,
  MessageId,
  ProviderInstanceId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { AXIS_CHATS_PROJECT_ID } from "../axis/chats/AxisChats.ts";

const now = "2026-09-09T00:00:00.000Z";
const threadId = ThreadId.make("standalone");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "auto" };
const createChat = (projectId: typeof AXIS_CHATS_PROJECT_ID | null): OrchestrationCommand => ({
  type: "thread.create",
  commandId: CommandId.make("create-chat"),
  threadId,
  projectId,
  title: "New thread",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: "/user/repo",
  createdAt: now,
});

const makeHarness = Effect.gen(function* () {
  let readModel = createEmptyReadModel(now);
  const dispatch = Effect.fn(function* (command: OrchestrationCommand) {
    const decided = yield* decideOrchestrationCommand({ readModel, command });
    const events = Array.isArray(decided) ? decided : [decided];
    for (const event of events) {
      readModel = yield* projectEvent(readModel, {
        ...event,
        sequence: readModel.snapshotSequence + 1,
      });
    }
    return events;
  });
  yield* dispatch({
    type: "project.create",
    commandId: CommandId.make("create-project"),
    projectId: AXIS_CHATS_PROJECT_ID,
    title: "Chats",
    workspaceRoot: "/state/chats",
    createdAt: now,
  });
  return { dispatch, read: () => readModel };
});

it.effect.each([null, AXIS_CHATS_PROJECT_ID])(
  "creates chats from desktop and mobile payloads (%s)",
  (projectId) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.dispatch(createChat(projectId));
      expect(harness.read().threads[0]).toMatchObject({
        id: threadId,
        projectId: AXIS_CHATS_PROJECT_ID,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
      });
      const events = yield* harness.dispatch({
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
      });
      expect(
        events.find((event) => event.type === "thread.turn-start-requested")?.payload,
      ).toMatchObject({ runtimeMode: "approval-required" });
      expect(harness.read().projects).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps Chats restrictions after renaming and preserves archive/unarchive", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* harness.dispatch(createChat(null));
    yield* harness.dispatch({
      type: "project.meta.update",
      commandId: CommandId.make("rename"),
      projectId: AXIS_CHATS_PROJECT_ID,
      title: "Conversas",
    });
    const rejected: OrchestrationCommand[] = [
      {
        type: "project.delete",
        commandId: CommandId.make("delete"),
        projectId: AXIS_CHATS_PROJECT_ID,
        force: true,
      },
      {
        type: "project.meta.update",
        commandId: CommandId.make("scripts"),
        projectId: AXIS_CHATS_PROJECT_ID,
        defaultThreadEnvMode: "worktree",
      },
      {
        type: "thread.meta.update",
        commandId: CommandId.make("worktree"),
        threadId,
        worktreePath: "/repo",
      },
      {
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("access"),
        threadId,
        runtimeMode: "full-access",
        createdAt: now,
      },
      {
        type: "thread.approval.respond",
        commandId: CommandId.make("approve"),
        threadId,
        requestId: ApprovalRequestId.make("request"),
        decision: "acceptAlways",
        createdAt: now,
      },
    ];
    for (const command of rejected) {
      expect((yield* harness.dispatch(command).pipe(Effect.flip))._tag).toBe(
        "OrchestrationCommandInvariantError",
      );
    }
    yield* harness.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive"),
      threadId,
    });
    expect(harness.read().threads[0]?.archivedAt).not.toBeNull();
    yield* harness.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("unarchive"),
      threadId,
    });
    expect(harness.read().threads[0]).toMatchObject({
      projectId: AXIS_CHATS_PROJECT_ID,
      archivedAt: null,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

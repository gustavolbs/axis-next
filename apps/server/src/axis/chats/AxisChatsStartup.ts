import { CommandId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AXIS_CHATS_PROJECT_ID, axisChatsDirectory } from "./AxisChats.ts";

export const ensureAxisChatsProject = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const workspaceRoot = axisChatsDirectory(config.stateDir);
  yield* fs.makeDirectory(workspaceRoot, { recursive: true });
  const project = yield* query.getProjectShellById(AXIS_CHATS_PROJECT_ID);
  if (Option.isNone(project))
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      projectId: AXIS_CHATS_PROJECT_ID,
      title: "Chats",
      workspaceRoot,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
  if (
    Option.isNone(project) ||
    project.value.workspaceRoot !== workspaceRoot ||
    project.value.defaultThreadEnvMode !== "local" ||
    project.value.autoPull === true ||
    project.value.scripts.length > 0
  ) {
    yield* engine.dispatch({
      type: "project.meta.update",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      projectId: AXIS_CHATS_PROJECT_ID,
      workspaceRoot,
      defaultThreadEnvMode: "local",
      autoPull: false,
      scripts: [],
    });
  }
});

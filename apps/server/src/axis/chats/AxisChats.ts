// @effect-diagnostics nodeBuiltinImport:off - pure native path resolution, shared with migration payloads.
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { ProjectId, type VcsStatusResult } from "@t3tools/contracts";

// This identity belongs to the environment, independently of the editable title.
export const AXIS_CHATS_PROJECT_ID = ProjectId.make("axis-managed-chats");

export function isAxisChatsProject(projectId: ProjectId | null | undefined): boolean {
  return projectId === AXIS_CHATS_PROJECT_ID;
}

export function axisChatsDirectory(stateDir: string): string {
  return NodePath.join(stateDir, "chats");
}

/** Recognizes the managed root and its per-conversation runtime directories. */
export function isAxisChatCwd(stateDir: string, cwd: string | undefined): boolean {
  if (cwd === undefined) return false;
  const relative = NodePath.relative(axisChatsDirectory(stateDir), cwd);
  return (
    relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  );
}

export const isAxisChatBinding = Schema.is(Schema.Struct({ axisChat: Schema.Literal(true) }));

export function axisChatDirectory(stateDir: string, threadId: string): string {
  return NodePath.join(axisChatsDirectory(stateDir), encodeURIComponent(threadId));
}

// Chats can live inside a checkout's data directory without inheriting its Git state.
export const axisChatsVcsStatus = {
  isRepo: false,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
} satisfies VcsStatusResult;

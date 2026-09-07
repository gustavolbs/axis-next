import * as Cause from "effect/Cause";
import { useCallback, useEffect, useState } from "react";

import { type AxisScratchChatId } from "@t3tools/contracts";

import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

/**
 * Loads the scratch chat list for the primary environment and exposes
 * mutators. The list refresh is keyed by the primary environment id so
 * that switching environments reloads automatically.
 */
export function useAxisScratchChats(includeArchived = false) {
  const primary = usePrimaryEnvironment();
  const environmentId = primary?.environmentId ?? null;
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.axisScratchChats({ environmentId, input: { includeArchived } }),
  );
  const createCommand = useAtomCommand(serverEnvironment.createAxisScratchChat);
  const archiveCommand = useAtomCommand(serverEnvironment.archiveAxisScratchChat);
  const removeCommand = useAtomCommand(serverEnvironment.removeAxisScratchChat);
  const refresh = query.refresh;
  useEffect(() => refresh(), [refresh]);

  return {
    environmentId,
    chats: query.data ?? [],
    isLoading: query.data === null && query.error === null,
    error: query.error,
    refresh: () => query.refresh(),
    create: createCommand,
    archive: archiveCommand,
    remove: removeCommand,
  };
}

export type SendState = "idle" | "sending" | "error";

/** Uses the shared stream projection for reconnects and incremental responses. */
export function useAxisScratchChatSession(chatId: AxisScratchChatId | string) {
  const primary = usePrimaryEnvironment();
  const environmentId = primary?.environmentId ?? null;
  const snapshotQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.axisScratchChatStream({
          environmentId,
          input: { chatId: chatId as AxisScratchChatId },
        }),
  );
  const sendCommand = useAtomCommand(serverEnvironment.sendAxisScratchChatMessage);
  const interruptCommand = useAtomCommand(serverEnvironment.interruptAxisScratchChat);

  const key = `${environmentId}:${chatId}`;
  const [commandState, setCommandState] = useState({
    key,
    pending: false,
    error: null as string | null,
  });
  const pending = commandState.key === key && commandState.pending;
  const sendError = commandState.key === key ? commandState.error : null;
  const running =
    snapshotQuery.data?.turnState === "running" || snapshotQuery.data?.turnState === "queued";
  const sendState: SendState =
    pending || running ? "sending" : sendError !== null ? "error" : "idle";

  const sendMessage = useCallback(
    async (text: string) => {
      if (environmentId === null || sendState === "sending") return false;
      setCommandState({ key, pending: true, error: null });
      const result = await sendCommand({
        environmentId,
        input: { chatId: chatId as AxisScratchChatId, text },
      });
      setCommandState((current) =>
        current.key === key
          ? {
              key,
              pending: false,
              error: result._tag === "Success" ? null : messageFromCause(result.cause),
            }
          : current,
      );
      if (result._tag !== "Success") {
        return false;
      }
      return true;
    },
    [chatId, environmentId, sendCommand, sendState, key],
  );

  return {
    snapshot: snapshotQuery.data,
    chat: snapshotQuery.data?.chat ?? null,
    messages: snapshotQuery.data?.messages ?? [],
    isLoading: snapshotQuery.data === null && snapshotQuery.error === null,
    error: snapshotQuery.error,
    sendState,
    sendError,
    sendMessage,
    interrupt: async () => {
      if (environmentId === null) return;
      const result = await interruptCommand({
        environmentId,
        input: { chatId: chatId as AxisScratchChatId },
      });
      if (result._tag !== "Success")
        setCommandState({ key, pending: false, error: messageFromCause(result.cause) });
    },
    refresh: () => snapshotQuery.refresh(),
  };
}

function messageFromCause(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "The scratch chat request failed.";
}

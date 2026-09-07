import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useRef } from "react";
import { Alert } from "react-native";

import { uuidv4 } from "../../lib/uuid";
import { useServerConfigs } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveStandaloneThreadTarget } from "./standalone-thread-creation.logic";

export function useNewStandaloneThread() {
  const configs = useServerConfigs();
  const create = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const pending = useRef(false);

  return useCallback(
    async (preferredEnvironmentId: EnvironmentId | null) => {
      if (pending.current) return null;
      const target = resolveStandaloneThreadTarget(configs, preferredEnvironmentId);
      if (!target) {
        Alert.alert(
          "No provider available",
          preferredEnvironmentId === null
            ? "Connect an environment with an available provider to create a chat."
            : "The selected environment has no available provider.",
        );
        return null;
      }

      pending.current = true;
      const threadId = ThreadId.make(uuidv4());
      try {
        const result = await create({
          environmentId: target.environmentId,
          input: {
            threadId,
            projectId: null,
            title: "New thread",
            modelSelection: target.modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
        });
        if (result._tag === "Success") {
          return { environmentId: target.environmentId, threadId } as const;
        }
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Alert.alert(
            "Could not create chat",
            error instanceof Error ? error.message : "The chat could not be created.",
          );
        }
        return null;
      } finally {
        pending.current = false;
      }
    },
    [configs],
  );
}

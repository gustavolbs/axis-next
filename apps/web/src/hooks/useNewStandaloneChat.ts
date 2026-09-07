import { useNavigate } from "@tanstack/react-router";
import { type EnvironmentId } from "@t3tools/contracts";
import { newThreadId } from "../lib/utils";
import { useCallback, useRef, useState } from "react";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useServerConfigs } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { toastManager } from "../components/ui/toast";
import { isUsableStandaloneChatProvider } from "./useNewStandaloneChat.logic";

export function useNewStandaloneChat() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const configs = useServerConfigs();
  const create = useAtomCommand(threadEnvironment.create);
  const navigate = useNavigate();
  const pending = useRef(false);
  const [creating, setCreating] = useState(false);
  const provider =
    primaryEnvironmentId === null
      ? undefined
      : configs.get(primaryEnvironmentId)?.providers.find(isUsableStandaloneChatProvider);
  const start = useCallback(
    async (targetEnvironmentId?: EnvironmentId) => {
      const environmentId = targetEnvironmentId ?? primaryEnvironmentId;
      if (environmentId === null || pending.current) return;
      const targetProvider = configs
        .get(environmentId)
        ?.providers.find(isUsableStandaloneChatProvider);
      if (!targetProvider) {
        toastManager.add({ type: "error", title: "No provider available" });
        return;
      }
      pending.current = true;
      setCreating(true);
      try {
        const threadId = newThreadId();
        const result = await create({
          environmentId,
          input: {
            threadId,
            projectId: null,
            title: "New thread",
            modelSelection: {
              instanceId: targetProvider.instanceId,
              model:
                targetProvider.models.find((model) => model.isDefault)?.slug ??
                targetProvider.models[0]?.slug ??
                "auto",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
        });
        if (result._tag === "Success") {
          await navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
        }
      } finally {
        pending.current = false;
        setCreating(false);
      }
    },
    [configs, primaryEnvironmentId],
  );
  return { start, creating, available: primaryEnvironmentId !== null && provider !== undefined };
}

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AxisScratchChatId } from "@t3tools/contracts";
import { useEffect } from "react";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";

import { SidebarInset } from "../components/ui/sidebar";

function ScratchChatRouteView() {
  const { chatId } = Route.useParams();
  const environmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.axisScratchChatSnapshot({
          environmentId,
          input: { chatId: AxisScratchChatId.make(chatId) },
        }),
  );
  const chat = query.data?.chat;
  useEffect(() => {
    if (!chat) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: chat.environmentId, threadId: chat.backingThreadId },
      replace: true,
    });
  }, [chat, navigate]);
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      {query.error && <p role="alert">{query.error}</p>}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/scratch/$chatId")({
  component: ScratchChatRouteView,
});

import { createFileRoute } from "@tanstack/react-router";

import { AxisScratchChatView } from "../features/axis/scratch/AxisScratchChatView";
import { SidebarInset } from "../components/ui/sidebar";

function ScratchChatRouteView() {
  const { chatId } = Route.useParams();
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <AxisScratchChatView chatId={chatId} />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/scratch/$chatId")({
  component: ScratchChatRouteView,
});

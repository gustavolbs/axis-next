import { createFileRoute } from "@tanstack/react-router";

import { AxisScratchChatList } from "../features/axis/scratch/AxisScratchChatList";
import { SidebarInset } from "../components/ui/sidebar";

function ScratchIndexRouteView() {
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <AxisScratchChatList />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/scratch/")({
  component: ScratchIndexRouteView,
});

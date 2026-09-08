import { createFileRoute } from "@tanstack/react-router";

import { useEffect, useRef } from "react";
import { useNewStandaloneChat } from "../hooks/useNewStandaloneChat";
import { Button } from "../components/ui/button";
import { MessageSquarePlusIcon } from "lucide-react";
import { SidebarInset } from "../components/ui/sidebar";

function ScratchIndexRouteView() {
  const { start, creating, available } = useNewStandaloneChat();
  const started = useRef(false);
  useEffect(() => {
    if (!available || started.current) return;
    started.current = true;
    void start();
  }, [available, start]);
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <Button disabled={!available || creating} onClick={() => void start()}>
        <MessageSquarePlusIcon />
        New chat
      </Button>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/scratch/")({
  component: ScratchIndexRouteView,
});

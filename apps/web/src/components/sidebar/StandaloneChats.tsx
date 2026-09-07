import { Link } from "@tanstack/react-router";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PlusIcon,
  PinIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNewStandaloneChat } from "../../hooks/useNewStandaloneChat";
import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";

export function StandaloneChats() {
  const threads = useThreadShells();
  const chats = useMemo(
    () =>
      threads
        .filter((thread) => thread.projectId === null && thread.archivedAt === null)
        .toSorted(
          (a, b) =>
            Number(b.pinnedAt != null) - Number(a.pinnedAt != null) ||
            b.updatedAt.localeCompare(a.updatedAt),
        ),
    [threads],
  );
  const [expanded, setExpanded] = useState(true);
  const { start, creating, available } = useNewStandaloneChat();
  return (
    <SidebarGroup className="px-2 py-1">
      <div className="flex h-8 items-center gap-1">
        <SidebarMenuButton
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="min-w-0 flex-1"
        >
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          <span className="flex-1">Chats</span>
          <span className="text-xs text-muted-foreground">{chats.length}</span>
        </SidebarMenuButton>
        <Button
          size="icon-xs"
          variant="ghost"
          title="New chat"
          aria-label="New chat"
          disabled={!available || creating}
          onClick={() => void start()}
        >
          <PlusIcon />
        </Button>
      </div>
      {expanded && (
        <SidebarMenu>
          {chats.map((thread) => (
            <StandaloneChatRow key={`${thread.environmentId}:${thread.id}`} thread={thread} />
          ))}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
}

function StandaloneChatRow({ thread }: { thread: EnvironmentThreadShell }) {
  const threadRef = useMemo(
    () => ({ environmentId: thread.environmentId, threadId: thread.id }),
    [thread.environmentId, thread.id],
  );
  const [title, setTitle] = useState<string | null>(null);
  const update = useAtomCommand(threadEnvironment.updateMetadata);
  const { isMobile, setOpenMobile } = useSidebar();
  const { openMenu } = useThreadActionMenu({
    threadRef,
    projectCwd: null,
    onStartRename: () => setTitle(thread.title),
  });
  return (
    <SidebarMenuItem
      className="group flex min-w-0 items-center"
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {title === null ? (
        <SidebarMenuButton
          render={
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: thread.environmentId, threadId: thread.id }}
              activeProps={{ "data-active": true }}
            />
          }
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
        >
          {thread.pinnedAt !== null ? <PinIcon /> : <MessageSquareIcon />}
          <span className="truncate">{thread.title}</span>
        </SidebarMenuButton>
      ) : (
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (!title.trim()) return;
            void update({
              environmentId: thread.environmentId,
              input: { threadId: thread.id, title: title.trim() },
            }).then((result) => {
              if (result._tag === "Success") setTitle(null);
            });
          }}
        >
          <Input
            autoFocus
            aria-label="Chat title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setTitle(null);
            }}
          />
        </form>
      )}
      <Button
        size="icon-xs"
        variant="ghost"
        title="Chat actions"
        aria-label={`Actions for ${thread.title}`}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          openMenu({ x: rect.left, y: rect.bottom });
        }}
      >
        <MoreHorizontalIcon />
      </Button>
    </SidebarMenuItem>
  );
}

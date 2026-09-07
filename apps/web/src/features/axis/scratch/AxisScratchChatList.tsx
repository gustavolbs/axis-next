import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import * as Cause from "effect/Cause";
import { useState } from "react";

import { type AxisScratchChat } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { useServerConfigs } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { serverEnvironment } from "~/state/server";

import { useAxisScratchChats } from "./useAxisScratchChats.ts";

export function AxisScratchChatList() {
  const navigate = useNavigate();
  const [includeArchived, setIncludeArchived] = useState(false);
  const { chats, isLoading, error, refresh, environmentId, create } =
    useAxisScratchChats(includeArchived);
  const configs = useServerConfigs();
  const providers = (
    environmentId === null ? [] : (configs.get(environmentId)?.providers ?? [])
  ).filter(
    (provider) => provider.enabled && provider.installed && provider.availability !== "unavailable",
  );
  const [instanceId, setInstanceId] = useState("");
  const [model, setModel] = useState("");
  const provider = providers.find((entry) => entry.instanceId === instanceId) ?? providers[0];
  const selectedModel =
    provider?.models.find((entry) => entry.slug === model)?.slug ??
    provider?.models.find((entry) => entry.isDefault)?.slug ??
    provider?.models[0]?.slug ??
    "auto";
  const [creating, setCreating] = useState(false);

  const onCreate = async () => {
    if (environmentId === null || creating || provider === undefined) return;
    setCreating(true);
    try {
      const draft = {
        modelSelection: { instanceId: provider.instanceId, model: selectedModel },
        providerInstanceId: provider.instanceId,
        runtimeMode: "approval-required" as const,
        interactionMode: "default" as const,
      };
      const result = await create({ environmentId, input: { draft } });
      if (result._tag !== "Success") {
        toastManager.add({
          type: "error",
          title: "Could not start a chat",
          description: messageFromCause(result.cause),
        });
        return;
      }
      await navigate({ to: "/scratch/$chatId", params: { chatId: result.value.id } });
    } finally {
      setCreating(false);
      refresh();
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col gap-4 p-3 sm:p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-sm font-semibold">Chats</h1>
        </div>
        <Button
          size="sm"
          disabled={environmentId === null || creating || provider === undefined}
          onClick={() => void onCreate()}
        >
          <MessageSquarePlusIcon className="size-4" />
          {creating ? "Starting…" : "New chat"}
        </Button>
      </header>
      <div className="flex flex-wrap items-center gap-3">
        <select
          aria-label="Provider"
          className="min-w-0 max-w-full rounded-md border bg-background px-2 py-1 text-sm"
          value={provider?.instanceId ?? ""}
          onChange={(event) => {
            setInstanceId(event.target.value);
            setModel("");
          }}
        >
          {providers.length === 0 && <option value="">No providers available</option>}
          {providers.map((entry) => (
            <option key={entry.instanceId} value={entry.instanceId}>
              {entry.displayName ?? entry.instanceId}
            </option>
          ))}
        </select>
        <select
          aria-label="Model"
          className="min-w-0 max-w-full rounded-md border bg-background px-2 py-1 text-sm"
          value={selectedModel}
          onChange={(event) => setModel(event.target.value)}
          disabled={!provider}
        >
          {!provider?.models.length && <option value="auto">Default model</option>}
          {provider?.models.map((entry) => (
            <option key={entry.slug} value={entry.slug}>
              {entry.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          Include archived
        </label>
      </div>

      {environmentId === null ? (
        <Empty>No environment connected.</Empty>
      ) : isLoading ? (
        <Empty>Loading chats…</Empty>
      ) : error !== null ? (
        <Empty>Could not load chats: {error}</Empty>
      ) : chats.length === 0 ? (
        <Empty>No chats yet.</Empty>
      ) : (
        <ul className="grid gap-2">
          {chats.map((chat) => (
            <li key={chat.id}>
              <ChatListItem chat={chat} onChanged={refresh} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ChatListItem({
  chat,
  onChanged,
}: {
  readonly chat: AxisScratchChat;
  readonly onChanged: () => void;
}) {
  const remove = useAtomCommand(serverEnvironment.removeAxisScratchChat);
  const archive = useAtomCommand(serverEnvironment.archiveAxisScratchChat);
  const patch = useAtomCommand(serverEnvironment.patchAxisScratchChat);
  const [removing, setRemoving] = useState(false);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  const onRemove = async () => {
    if (!confirm(`Delete chat '${chat.title}'?`)) return;
    setRemoving(true);
    try {
      const result = await remove({
        environmentId: chat.environmentId,
        input: { chatId: chat.id },
      });
      if (result._tag !== "Success") {
        toastManager.add({
          type: "error",
          title: "Could not delete chat",
          description: messageFromCause(result.cause),
        });
        return;
      }
      toastManager.add({ type: "info", title: `Deleted '${chat.title}'.` });
    } finally {
      setRemoving(false);
      onChanged();
    }
  };

  return (
    <div
      className={cn(
        "group flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-border/70 bg-card/45 p-3 transition-colors hover:border-border hover:bg-card/70",
      )}
    >
      <Link to="/scratch/$chatId" params={{ chatId: chat.id }} className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{chat.title}</p>
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {chat.lastMessagePreview ?? "No messages yet."}
        </p>
        <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          {chat.messageCount} message{chat.messageCount === 1 ? "" : "s"}
          {chat.archivedAt !== null ? " · archived" : ""}
        </p>
      </Link>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label="Rename chat"
        title="Rename chat"
        onClick={(event) => {
          event.stopPropagation();
          setEditingTitle(chat.title);
        }}
      >
        <PencilIcon />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={chat.archivedAt === null ? "Archive chat" : "Restore chat"}
        title={chat.archivedAt === null ? "Archive chat" : "Restore chat"}
        onClick={(event) => {
          event.stopPropagation();
          void archive({
            environmentId: chat.environmentId,
            input: { chatId: chat.id, archived: chat.archivedAt === null },
          }).then((result) => {
            if (result._tag !== "Success")
              toastManager.add({
                type: "error",
                title: "Could not update chat",
                description: messageFromCause(result.cause),
              });
            onChanged();
          });
        }}
      >
        {chat.archivedAt === null ? <ArchiveIcon /> : <ArchiveRestoreIcon />}
      </Button>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={`Delete ${chat.title}`}
        disabled={removing}
        onClick={(event) => {
          event.stopPropagation();
          void onRemove();
        }}
      >
        <Trash2Icon />
      </Button>
      <Dialog
        open={editingTitle !== null}
        onOpenChange={(open) => {
          if (!open) setEditingTitle(null);
        }}
      >
        <DialogPopup>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const title = editingTitle?.trim();
              if (!title || renaming) return;
              setRenaming(true);
              void patch({
                environmentId: chat.environmentId,
                input: { patch: { id: chat.id, title } },
              }).then((result) => {
                setRenaming(false);
                if (result._tag !== "Success") {
                  toastManager.add({
                    type: "error",
                    title: "Could not rename chat",
                    description: messageFromCause(result.cause),
                  });
                  return;
                }
                setEditingTitle(null);
                onChanged();
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename chat</DialogTitle>
            </DialogHeader>
            <div className="px-6 pb-4">
              <Input
                aria-label="Chat title"
                maxLength={200}
                value={editingTitle ?? ""}
                onChange={(event) => setEditingTitle(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditingTitle(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={renaming || !editingTitle?.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function Empty({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center px-5 py-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function messageFromCause(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Unknown error.";
}

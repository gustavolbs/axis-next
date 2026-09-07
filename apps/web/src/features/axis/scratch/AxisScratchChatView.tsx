import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, SendHorizonalIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";

import { AxisScratchChatMessageList } from "./AxisScratchChatMessageList.tsx";
import { useAxisScratchChatSession } from "./useAxisScratchChats.ts";

export function AxisScratchChatView({ chatId }: { readonly chatId: string }) {
  const navigate = useNavigate();
  const { chat, messages, isLoading, error, sendState, sendError, sendMessage, interrupt } =
    useAxisScratchChatSession(chatId);
  const [draft, setDraft] = useState("");
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const followTail = useRef(true);
  const lastMessageText = messages.at(-1)?.text ?? "";

  // Auto-scroll to the latest message whenever new ones arrive.
  useEffect(() => {
    if (!followTail.current || !lastMessageText) return;
    const node = scrollerRef.current;
    if (node === null) return;
    node.scrollTop = node.scrollHeight;
  }, [lastMessageText]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (text.length === 0 || sendState === "sending") return;
    void sendMessage(text).then((sent) => {
      if (sent) setDraft("");
    });
  };

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-border/70 bg-background/95 px-3 py-3 backdrop-blur sm:px-5">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Back to chats"
          onClick={() => void navigate({ to: "/scratch" })}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{chat?.title ?? "Chat"}</h1>
          {chat === null ? (
            <p className="text-xs text-muted-foreground">
              <Link to="/scratch">Chats</Link>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {chat.messageCount} message{chat.messageCount === 1 ? "" : "s"} · provider{" "}
              {chat.providerInstanceId}
            </p>
          )}
        </div>
      </header>

      <div
        ref={scrollerRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          followTail.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto bg-background/40 p-3 sm:p-5"
      >
        {error !== null ? (
          <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            Could not load chat: {error}
          </div>
        ) : isLoading ? (
          <div className="flex h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </div>
        ) : (
          <AxisScratchChatMessageList messages={messages} />
        )}
      </div>

      <footer className="border-t border-border/70 bg-background/95 p-3 backdrop-blur sm:p-5">
        <form className="flex flex-col gap-2" onSubmit={onSubmit}>
          <textarea
            className="min-h-20 w-full resize-none rounded-xl border border-border/70 bg-card/60 px-3 py-2 text-sm outline-none focus:border-primary/60"
            placeholder="Send a message…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={sendState === "sending" || chat === null || chat.archivedAt !== null}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {sendError !== null ? <span className="text-destructive">{sendError}</span> : null}
            </p>
            {sendState === "sending" ? (
              <Button
                type="button"
                size="icon"
                aria-label="Stop response"
                title="Stop response"
                onClick={() => void interrupt()}
              >
                <SquareIcon className="size-4" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="sm"
                disabled={draft.trim().length === 0 || chat === null || chat.archivedAt !== null}
              >
                <SendHorizonalIcon className="size-4" />
                Send
              </Button>
            )}
          </div>
        </form>
      </footer>
    </section>
  );
}

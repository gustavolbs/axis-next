import { type ReactNode } from "react";

import { type AxisScratchChatMessage } from "@t3tools/contracts";
import { SparklesIcon, UserIcon } from "lucide-react";

import { cn } from "~/lib/utils";

export function AxisScratchChatMessageList({
  messages,
}: {
  readonly messages: ReadonlyArray<AxisScratchChatMessage>;
}) {
  if (messages.length === 0) {
    return (
      <div className="flex min-h-32 flex-col items-center justify-center gap-2 px-5 py-10 text-center text-sm text-muted-foreground">
        <p>No messages yet.</p>
      </div>
    );
  }
  return (
    <ol className="flex flex-col gap-3">
      {messages.map((message) => (
        <li key={message.id}>
          <MessageBubble message={message} />
        </li>
      ))}
    </ol>
  );
}

function MessageBubble({ message }: { readonly message: AxisScratchChatMessage }): ReactNode {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  return (
    <article
      className={cn(
        "flex items-start gap-3 rounded-lg border px-4 py-3",
        isUser
          ? "border-primary/30 bg-primary/5"
          : isSystem
            ? "border-border/70 bg-card/65"
            : "border-border/70 bg-card/45",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
          isUser ? "bg-primary text-primary-foreground" : "bg-foreground/10 text-foreground",
        )}
        aria-hidden
      >
        {isUser ? <UserIcon className="size-3.5" /> : <SparklesIcon className="size-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <header className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {isUser ? "You" : isSystem ? "System" : "Assistant"}
          </span>
          {message.streaming === true ? (
            <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
              streaming
            </span>
          ) : null}
        </header>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
          {message.text}
        </p>
      </div>
    </article>
  );
}

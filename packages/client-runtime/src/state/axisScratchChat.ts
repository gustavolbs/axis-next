import type { AxisScratchChatSnapshot, AxisScratchChatStreamEvent } from "@t3tools/contracts";

/** Fold before the atom publishes so React batching cannot drop streamed text. */
export function applyScratchChatEvent(
  snapshot: AxisScratchChatSnapshot | null,
  event: AxisScratchChatStreamEvent,
): AxisScratchChatSnapshot | null {
  if (event.kind === "snapshot") return event.snapshot;
  if (event.kind === "chat-removed") return null;
  if (snapshot === null) return null;
  switch (event.kind) {
    case "message-appended": {
      const exists = snapshot.messages.some((message) => message.id === event.message.id);
      return {
        ...snapshot,
        messages: exists
          ? snapshot.messages.map((message) =>
              message.id === event.message.id ? event.message : message,
            )
          : [...snapshot.messages, event.message],
        cursor: event.message.streaming ? snapshot.cursor : event.message.id,
        chat: {
          ...snapshot.chat,
          messageCount: event.message.streaming
            ? snapshot.chat.messageCount
            : Math.max(snapshot.chat.messageCount, event.message.turnIndex + 1),
        },
      };
    }
    case "message-delta":
      return {
        ...snapshot,
        messages: snapshot.messages.map((message) =>
          message.id === event.messageId
            ? { ...message, text: message.text + event.delta }
            : message,
        ),
      };
    case "turn-state":
      return {
        ...snapshot,
        turnState: event.state,
        messages:
          event.state === "running" || event.state === "queued"
            ? snapshot.messages
            : snapshot.messages.map((message) => ({ ...message, streaming: false })),
      };
    case "chat-patched":
    case "chat-archived":
      return { ...snapshot, chat: event.chat };
    default:
      return snapshot;
  }
}

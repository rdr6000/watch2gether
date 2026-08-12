import type { RoomContext } from "../room-context";
import type { PeerAttachment } from "../types";

/** Persists the message (capped, see room-durable-object.ts) then broadcasts it to everyone, including the sender. */
export function handleChat(ctx: RoomContext, from: PeerAttachment, body: string): void {
  if (!ctx.meta.chatEnabled) return;

  const message = {
    id: ctx.generateId(),
    senderId: from.clientId,
    senderName: from.name,
    body,
    sentAt: ctx.now()
  };
  ctx.chatHistory.append(message);
  ctx.broadcast({ type: "chat", ...message });
}

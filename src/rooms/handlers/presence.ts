import type { RoomContext } from "../room-context";
import { peerSummaries, roleFor, roomSettings } from "../room-context";
import type { PeerAttachment } from "../types";

export type JoinDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Gate checked before a join is allowed to proceed at all. Bans always apply.
 * A lock only blocks new viewers from joining an *occupied* room — if there's
 * currently no host (room just emptied, or this is the very first joiner),
 * the join is allowed through regardless of the lock, since there is no
 * persistent identity to recognize "the same host reconnecting" by.
 */
export function checkJoinAllowed(ctx: RoomContext, ip: string): JoinDecision {
  if (ctx.bans.isBanned(ip)) return { allowed: false, reason: "You are banned from this room." };
  if (ctx.meta.locked && ctx.meta.hostClientId !== null) return { allowed: false, reason: "This room is locked." };
  if (ctx.meta.maxPeers !== null && ctx.peers().length >= ctx.meta.maxPeers) {
    return { allowed: false, reason: "This room is full." };
  }
  return { allowed: true };
}

/**
 * Assigns host if the room is empty, otherwise viewer. Pure state + attachment
 * construction — no I/O — so the caller can persist the attachment onto the
 * socket (ws.serializeAttachment) *before* announceJoin runs. Order matters:
 * ctx.peers() is derived live from each socket's attachment, so the new
 * joiner must be attached first or it's invisible to its own join broadcast.
 */
export function assignRole(ctx: RoomContext, clientId: string, name: string | undefined, ip: string): PeerAttachment {
  if (!ctx.meta.hostClientId) {
    ctx.meta.hostClientId = clientId;
    ctx.saveMeta();
  }

  const role = roleFor(ctx, clientId);
  const now = ctx.now();
  return {
    clientId,
    role,
    name: (name || "").trim().slice(0, 40) || (role === "host" ? "Host" : "Viewer"),
    joinedAt: now,
    lastSeenAt: now,
    ip
  };
}

/** Sends the joiner its room state and tells everyone else who just arrived. */
export function announceJoin(ctx: RoomContext, ws: WebSocket, attachment: PeerAttachment): void {
  ctx.meta.emptySince = null;
  if (ctx.peers().length >= 2) ctx.meta.everHadSecondPeer = true;
  ctx.saveMeta();

  ctx.send(ws, {
    type: "state",
    room: ctx.meta.roomId,
    host: attachment.role === "host",
    clientId: attachment.clientId,
    allowGuestControl: ctx.meta.allowGuestControl,
    hasActiveSource: ctx.meta.hasActiveSource,
    peers: peerSummaries(ctx),
    ...roomSettings(ctx)
  });

  ctx.send(ws, { type: "chatHistory", messages: ctx.chatHistory.recent() });
  ctx.broadcast({ type: "presence", peers: peerSummaries(ctx) }, ws);
}

/** Runs after a connection closes. Reassigns host if the host just left. */
export function handleLeave(ctx: RoomContext, leftAttachment: PeerAttachment): void {
  if (ctx.peers().length === 0) {
    ctx.meta.emptySince = ctx.now();
    ctx.saveMeta();
  }

  if (ctx.meta.hostClientId !== leftAttachment.clientId) {
    ctx.broadcast({ type: "presence", peers: peerSummaries(ctx) });
    return;
  }

  const remaining = ctx.peers();
  const next = remaining[0];
  ctx.meta.hostClientId = next ? next.attachment.clientId : null;
  ctx.meta.hasActiveSource = false;
  ctx.saveMeta();

  if (next) {
    next.attachment.role = "host";
    ctx.broadcast({ type: "hostChanged", hostClientId: next.attachment.clientId });
  }
  ctx.broadcast({ type: "presence", peers: peerSummaries(ctx) });
}

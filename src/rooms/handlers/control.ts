import type { RoomContext } from "../room-context";
import { isHost } from "../room-context";
import type { ClientMessage, PeerAttachment } from "../types";

/** Only the host may toggle whether viewers can send control requests. */
export function handleControlAccess(ctx: RoomContext, from: PeerAttachment, allow: boolean): void {
  if (!isHost(ctx, from.clientId)) return;
  ctx.meta.allowGuestControl = allow;
  ctx.saveMeta();
  ctx.broadcast({ type: "controlAccess", allow });
}

/**
 * A viewer asking the host to play/pause/seek its actual video element.
 * There is no separate "sync" state to reconcile: the host is the only
 * source of truth, and every viewer is watching its live captured stream.
 * Routed one-way, viewer -> host, so the sender never sees its own request
 * echoed back — the bug that made "everyone can control" jitter before.
 */
export function handleControlRequest(
  ctx: RoomContext,
  from: PeerAttachment,
  msg: Extract<ClientMessage, { type: "controlRequest" }>
): void {
  if (isHost(ctx, from.clientId)) return; // host controls itself directly, no round-trip needed
  if (!ctx.meta.allowGuestControl) return;

  const host = ctx.meta.hostClientId ? ctx.peerByClientId(ctx.meta.hostClientId) : undefined;
  if (!host) return;

  ctx.send(host.ws, {
    type: "controlRequest",
    from: from.clientId,
    action: msg.action,
    position: msg.position
  });
}

/** Host broadcasts its current position periodically so viewers can calibrate subtitle timing (see types.ts). */
export function handlePositionUpdate(ctx: RoomContext, from: PeerAttachment, position: number, playing: boolean): void {
  if (!isHost(ctx, from.clientId)) return;
  ctx.broadcast({ type: "positionSync", position, playing, serverTime: ctx.now() }, ctx.peerByClientId(from.clientId)?.ws);
}

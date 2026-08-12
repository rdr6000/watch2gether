import type { RoomContext } from "../room-context";
import { isHost, roomSettings } from "../room-context";
import type { PeerAttachment, RoomSettings } from "../types";

/** Removes a peer immediately; they may rejoin (unlike a ban). */
export function handleKick(ctx: RoomContext, from: PeerAttachment, targetClientId: string): void {
  if (!isHost(ctx, from.clientId) || targetClientId === from.clientId) return;
  const target = ctx.peerByClientId(targetClientId);
  if (!target) return;

  ctx.send(target.ws, { type: "kicked", reason: "The host removed you from the room." });
  ctx.closePeer(target.ws, 4001, "kicked");
}

/** Removes a peer and blocks their IP from rejoining this room. */
export function handleBan(ctx: RoomContext, from: PeerAttachment, targetClientId: string): void {
  if (!isHost(ctx, from.clientId) || targetClientId === from.clientId) return;
  const target = ctx.peerByClientId(targetClientId);
  if (!target) return;

  ctx.bans.ban(target.attachment.ip, target.attachment.name);
  ctx.send(target.ws, { type: "banned", reason: "The host banned you from this room." });
  ctx.closePeer(target.ws, 4001, "banned");
}

/** Host-only partial update to room settings (lock, capacity, chat/voice availability). */
export function handleRoomSettings(ctx: RoomContext, from: PeerAttachment, patch: Partial<RoomSettings>): void {
  if (!isHost(ctx, from.clientId)) return;

  if (patch.locked !== undefined) ctx.meta.locked = patch.locked;
  if (patch.maxPeers !== undefined) ctx.meta.maxPeers = patch.maxPeers;
  if (patch.chatEnabled !== undefined) ctx.meta.chatEnabled = patch.chatEnabled;
  if (patch.voiceEnabled !== undefined) ctx.meta.voiceEnabled = patch.voiceEnabled;
  ctx.saveMeta();

  ctx.broadcast({ type: "roomSettings", ...roomSettings(ctx) });
}

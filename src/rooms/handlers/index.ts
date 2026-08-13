import type { RoomContext } from "../room-context";
import type { ClientMessage, PeerAttachment } from "../types";
import { handleControlAccess, handleControlRequest, handlePositionUpdate } from "./control";
import { handleChat } from "./chat";
import { handleRtcRelay, handleSourceReady } from "./signaling";
import { handleBan, handleKick, handleRoomSettings } from "./moderation";
import { handleSubtitleShare } from "./subtitles";

export { announceJoin, assignRole, checkJoinAllowed, handleLeave } from "./presence";

/**
 * Routes an already-validated, post-join message to its feature handler.
 * Adding a new message type means adding one case here and one new handler
 * module — nothing else in the Durable Object changes (open/closed).
 */
export function dispatchMessage(ctx: RoomContext, from: PeerAttachment, msg: ClientMessage): void {
  switch (msg.type) {
    case "controlAccess":
      handleControlAccess(ctx, from, msg.allow);
      return;
    case "sourceReady":
      handleSourceReady(ctx, from, msg.ready);
      return;
    case "controlRequest":
      handleControlRequest(ctx, from, msg);
      return;
    case "rtcOffer":
    case "rtcAnswer":
    case "rtcIceCandidate":
      handleRtcRelay(ctx, from, msg);
      return;
    case "chat":
      handleChat(ctx, from, msg.body);
      return;
    case "positionUpdate":
      handlePositionUpdate(ctx, from, msg.position, msg.playing, msg.duration ?? null);
      return;
    case "kickPeer":
      handleKick(ctx, from, msg.clientId);
      return;
    case "banPeer":
      handleBan(ctx, from, msg.clientId);
      return;
    case "roomSettings":
      handleRoomSettings(ctx, from, msg);
      return;
    case "subtitleShare":
      handleSubtitleShare(ctx, from, msg);
      return;
    case "pong":
      return; // liveness only — lastSeenAt is already refreshed by the caller for every message
    case "join":
      return; // handled once, before dispatch is reachable
  }
}

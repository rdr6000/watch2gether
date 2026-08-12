import type { RoomContext } from "../room-context";
import { isHost } from "../room-context";
import type { ClientMessage, PeerAttachment } from "../types";

/**
 * Relays WebRTC SDP/ICE between exactly two peers (host <-> one viewer at a
 * time). The Durable Object never inspects the payload — it only routes it
 * to `targetId`, the same pattern for offer, answer, and ICE candidates.
 */
export function handleRtcRelay(
  ctx: RoomContext,
  from: PeerAttachment,
  msg: Extract<ClientMessage, { type: "rtcOffer" | "rtcAnswer" | "rtcIceCandidate" }>
): void {
  if (msg.purpose === "voice" && !ctx.meta.voiceEnabled) return;

  const target = ctx.peerByClientId(msg.targetId);
  if (!target) return;

  if (msg.type === "rtcOffer") {
    ctx.send(target.ws, { type: "rtcOffer", fromId: from.clientId, sdp: msg.sdp, purpose: msg.purpose });
  } else if (msg.type === "rtcAnswer") {
    ctx.send(target.ws, { type: "rtcAnswer", fromId: from.clientId, sdp: msg.sdp, purpose: msg.purpose });
  } else {
    ctx.send(target.ws, { type: "rtcIceCandidate", fromId: from.clientId, candidate: msg.candidate, purpose: msg.purpose });
  }
}

/** Host announces whether its captured video source is currently streamable. */
export function handleSourceReady(ctx: RoomContext, from: PeerAttachment, ready: boolean): void {
  if (!isHost(ctx, from.clientId)) return;
  ctx.meta.hasActiveSource = ready;
  ctx.saveMeta();
  ctx.broadcast({ type: "sourceReady", ready }, undefined);
}

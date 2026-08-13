import type { ClientMessage, RtcIceCandidate, RtcPurpose, RtcSessionDescription } from "./types";

function parseRtcPurpose(value: unknown): RtcPurpose | null {
  return value === "video" || value === "voice" ? value : null;
}

/** undefined = "field not present, leave unchanged"; null propagates through for maxPeers = unlimited. */
function parseOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

const MAX_NAME_LENGTH = 40;
const MAX_CHAT_LENGTH = 1000;
const MAX_ROOM_CAPACITY = 200;
/** Generous for even a long, heavily-formatted .srt/.vtt — real files are rarely above a few hundred KB. */
const MAX_SUBTITLE_BYTES = 300_000;

/**
 * Checked against the raw string *before* JSON.parse, so an oversized payload
 * never gets parsed at all. Sized to fit a shared subtitle file (see
 * MAX_SUBTITLE_BYTES) plus JSON/escaping overhead — every other message type
 * is far smaller than this in practice, so this is a ceiling, not a target.
 */
export const MAX_RAW_MESSAGE_BYTES = 320 * 1024;

/** Hand-rolled runtime validation — kept dependency-free on purpose (see plan: "free/simple to self-host"). */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;
  if (typeof msg.type !== "string") return null;

  switch (msg.type) {
    case "join":
      if (typeof msg.room !== "string") return null;
      return {
        type: "join",
        room: msg.room,
        name: typeof msg.name === "string" ? msg.name.slice(0, MAX_NAME_LENGTH) : undefined
      };

    case "controlAccess":
      if (typeof msg.allow !== "boolean") return null;
      return { type: "controlAccess", allow: msg.allow };

    case "sourceReady":
      if (typeof msg.ready !== "boolean") return null;
      return { type: "sourceReady", ready: msg.ready };

    case "controlRequest":
      if (msg.action !== "play" && msg.action !== "pause" && msg.action !== "seek") return null;
      return {
        type: "controlRequest",
        action: msg.action,
        position: typeof msg.position === "number" && Number.isFinite(msg.position) ? msg.position : undefined
      };

    case "rtcOffer":
    case "rtcAnswer": {
      const purpose = parseRtcPurpose(msg.purpose);
      if (typeof msg.targetId !== "string" || typeof msg.sdp !== "object" || msg.sdp === null || !purpose) return null;
      return { type: msg.type, targetId: msg.targetId, sdp: msg.sdp as RtcSessionDescription, purpose };
    }

    case "rtcIceCandidate": {
      const purpose = parseRtcPurpose(msg.purpose);
      if (typeof msg.targetId !== "string" || typeof msg.candidate !== "object" || msg.candidate === null || !purpose) return null;
      return { type: "rtcIceCandidate", targetId: msg.targetId, candidate: msg.candidate as RtcIceCandidate, purpose };
    }

    case "chat":
      if (typeof msg.body !== "string" || !msg.body.trim()) return null;
      return { type: "chat", body: msg.body.slice(0, MAX_CHAT_LENGTH) };

    case "positionUpdate":
      if (typeof msg.position !== "number" || !Number.isFinite(msg.position) || typeof msg.playing !== "boolean") return null;
      return {
        type: "positionUpdate",
        position: msg.position,
        playing: msg.playing,
        duration: typeof msg.duration === "number" && Number.isFinite(msg.duration) ? msg.duration : undefined
      };

    case "kickPeer":
      if (typeof msg.clientId !== "string") return null;
      return { type: "kickPeer", clientId: msg.clientId };

    case "banPeer":
      if (typeof msg.clientId !== "string") return null;
      return { type: "banPeer", clientId: msg.clientId };

    case "roomSettings": {
      let maxPeers: number | null | undefined;
      if (msg.maxPeers === null) maxPeers = null;
      else if (typeof msg.maxPeers === "number" && Number.isInteger(msg.maxPeers) && msg.maxPeers >= 1 && msg.maxPeers <= MAX_ROOM_CAPACITY) {
        maxPeers = msg.maxPeers;
      }
      return {
        type: "roomSettings",
        locked: parseOptionalBoolean(msg.locked),
        maxPeers,
        chatEnabled: parseOptionalBoolean(msg.chatEnabled),
        voiceEnabled: parseOptionalBoolean(msg.voiceEnabled)
      };
    }

    case "subtitleShare":
      if (typeof msg.name !== "string" || typeof msg.content !== "string" || msg.content.length > MAX_SUBTITLE_BYTES) {
        return null;
      }
      return { type: "subtitleShare", name: msg.name.slice(0, 200), content: msg.content };

    case "pong":
      return { type: "pong" };

    default:
      return null;
  }
}

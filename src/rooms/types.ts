export interface Env {
  ROOM_DO: DurableObjectNamespace<import("./room-durable-object").RoomDurableObject>;
  ASSETS: Fetcher;
}

/** A connection's role within a room. Host owns the video source. */
export type PeerRole = "host" | "viewer";

/** Per-connection data attached to the hibernatable WebSocket (survives hibernation). */
export interface PeerAttachment {
  clientId: string;
  role: PeerRole;
  name: string;
  joinedAt: number;
  /** Refreshed on every inbound message (including pong replies); drives the dead-peer sweep in gc.ts. */
  lastSeenAt: number;
  /** cf-connecting-ip at the time this socket upgraded — the only thing a kick/ban can key on with no accounts. */
  ip: string;
}

export interface RoomMeta {
  roomId: string;
  hostClientId: string | null;
  allowGuestControl: boolean;
  hasActiveSource: boolean;
  createdAt: number;
  locked: boolean;
  /** null = unlimited. Counts every connected peer, host included. */
  maxPeers: number | null;
  chatEnabled: boolean;
  voiceEnabled: boolean;
  /** Timestamp the room last had zero peers, or null while occupied — drives the empty-room GC sweep. */
  emptySince: number | null;
  /** Once true, the room is exempt from the "nobody joined the host within 5 minutes" expiry. */
  everHadSecondPeer: boolean;
}

/** The subset of room settings a host can change after creation, and what gets broadcast on change. */
export interface RoomSettings {
  locked: boolean;
  maxPeers: number | null;
  chatEnabled: boolean;
  voiceEnabled: boolean;
}

/**
 * WebRTC's own types (RTCSessionDescriptionInit, RTCIceCandidateInit) live in
 * lib.dom, which this Worker doesn't include — it only ever relays these as
 * opaque JSON, never constructs or inspects them. Minimal shapes of our own
 * keep validation.ts honest without pulling in the DOM lib.
 */
export interface RtcSessionDescription {
  type: string;
  sdp: string;
}

export interface RtcIceCandidate {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface ChatMessageRecord {
  id: string;
  senderId: string;
  senderName: string;
  body: string;
  sentAt: number;
}

/**
 * The Durable Object relays RTC signaling blindly by targetId — it never
 * looks at the SDP/candidate contents. `purpose` exists purely so two
 * clients can run two independent RTCPeerConnections with each other (the
 * host's video broadcast, and this pair's voice-chat link) without an
 * incoming offer/answer/candidate being ambiguous about which one it's for.
 */
export type RtcPurpose = "video" | "voice";

/** Discriminated union of every client -> server message. */
export type ClientMessage =
  | { type: "join"; room: string; name?: string }
  | { type: "controlAccess"; allow: boolean }
  | { type: "sourceReady"; ready: boolean }
  | { type: "controlRequest"; action: "play" | "pause" | "seek"; position?: number }
  | { type: "rtcOffer"; targetId: string; sdp: RtcSessionDescription; purpose: RtcPurpose }
  | { type: "rtcAnswer"; targetId: string; sdp: RtcSessionDescription; purpose: RtcPurpose }
  | { type: "rtcIceCandidate"; targetId: string; candidate: RtcIceCandidate; purpose: RtcPurpose }
  | { type: "chat"; body: string }
  | { type: "positionUpdate"; position: number; playing: boolean }
  | { type: "kickPeer"; clientId: string }
  | { type: "banPeer"; clientId: string }
  | { type: "roomSettings"; locked?: boolean; maxPeers?: number | null; chatEnabled?: boolean; voiceEnabled?: boolean }
  | { type: "pong" };

/** Discriminated union of every server -> client message. */
export type ServerMessage =
  | { type: "error"; message: string }
  | ({
      type: "state";
      room: string;
      host: boolean;
      clientId: string;
      allowGuestControl: boolean;
      hasActiveSource: boolean;
      peers: Array<{ clientId: string; role: PeerRole; name: string }>;
    } & RoomSettings)
  | { type: "presence"; peers: Array<{ clientId: string; role: PeerRole; name: string }> }
  | { type: "hostChanged"; hostClientId: string }
  | { type: "controlAccess"; allow: boolean }
  | { type: "sourceReady"; ready: boolean }
  | { type: "controlRequest"; from: string; action: "play" | "pause" | "seek"; position?: number }
  | { type: "rtcOffer"; fromId: string; sdp: RtcSessionDescription; purpose: RtcPurpose }
  | { type: "rtcAnswer"; fromId: string; sdp: RtcSessionDescription; purpose: RtcPurpose }
  | { type: "rtcIceCandidate"; fromId: string; candidate: RtcIceCandidate; purpose: RtcPurpose }
  | ({ type: "chat" } & ChatMessageRecord)
  | { type: "chatHistory"; messages: ChatMessageRecord[] }
  /**
   * Informational only — never used to control playback (the live captured
   * stream already *is* the playback). Viewers use it purely to estimate the
   * host's current position for local subtitle-cue timing and a scrub-bar
   * readout, since a viewer's own <video> currentTime tracks how long it has
   * been rendering the stream, not the host's absolute position in the file.
   */
  | { type: "positionSync"; position: number; playing: boolean; serverTime: number }
  | ({ type: "roomSettings" } & RoomSettings)
  | { type: "kicked"; reason: string }
  | { type: "banned"; reason: string }
  | { type: "roomExpired"; reason: string }
  | { type: "ping" };

import type { ChatMessageRecord, PeerAttachment, PeerRole, RoomMeta, ServerMessage } from "./types";

/**
 * Narrow interface handlers depend on instead of the concrete Durable Object.
 * Lets tests exercise handlers against an in-memory fake (see test/handlers.*.test.ts)
 * without spinning up a real Durable Object.
 */
export interface RoomContext {
  readonly meta: RoomMeta;
  now(): number;
  peers(): Array<{ ws: WebSocket; attachment: PeerAttachment }>;
  peerByClientId(clientId: string): { ws: WebSocket; attachment: PeerAttachment } | undefined;
  send(ws: WebSocket, message: ServerMessage): void;
  broadcast(message: ServerMessage, exceptWs?: WebSocket): void;
  saveMeta(): void;
  generateId(): string;
  chatHistory: {
    append(message: ChatMessageRecord): void;
    recent(): ChatMessageRecord[];
  };
  bans: {
    isBanned(ip: string): boolean;
    ban(ip: string, name: string): void;
  };
  /** Closes a peer's socket with an app-defined WS close code (4000-4999) and reason string. */
  closePeer(ws: WebSocket, code: number, reason: string): void;
}

export function roomSettings(ctx: RoomContext) {
  return {
    locked: ctx.meta.locked,
    maxPeers: ctx.meta.maxPeers,
    chatEnabled: ctx.meta.chatEnabled,
    voiceEnabled: ctx.meta.voiceEnabled
  };
}

export function peerSummaries(ctx: RoomContext) {
  return ctx.peers().map(({ attachment }) => ({
    clientId: attachment.clientId,
    role: attachment.role,
    name: attachment.name
  }));
}

export function isHost(ctx: RoomContext, clientId: string): boolean {
  return ctx.meta.hostClientId === clientId;
}

export function roleFor(ctx: RoomContext, clientId: string): PeerRole {
  return isHost(ctx, clientId) ? "host" : "viewer";
}

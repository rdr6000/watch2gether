import { describe, expect, it } from "vitest";
import { announceJoin, assignRole, checkJoinAllowed, handleLeave } from "../src/rooms/handlers/presence";
import { handleControlAccess, handleControlRequest, handlePositionUpdate } from "../src/rooms/handlers/control";
import { handleRtcRelay, handleSourceReady } from "../src/rooms/handlers/signaling";
import { handleChat } from "../src/rooms/handlers/chat";
import { handleBan, handleKick, handleRoomSettings } from "../src/rooms/handlers/moderation";
import { handleSubtitleShare } from "../src/rooms/handlers/subtitles";
import type { RoomContext } from "../src/rooms/room-context";
import type { ChatMessageRecord, PeerAttachment, RoomMeta, ServerMessage } from "../src/rooms/types";

class FakeSocket {
  received: ServerMessage[] = [];
  closed = null as { code: number; reason: string } | null;
}

function createFakeContext(overrides: Partial<RoomMeta> = {}) {
  const meta: RoomMeta = {
    roomId: "TESTROOM",
    hostClientId: null,
    allowGuestControl: false,
    hasActiveSource: false,
    createdAt: 0,
    locked: false,
    maxPeers: null,
    chatEnabled: true,
    voiceEnabled: true,
    emptySince: null,
    everHadSecondPeer: false,
    sharedSubtitle: null,
    ...overrides
  };
  const registry: Array<{ ws: WebSocket; attachment: PeerAttachment }> = [];
  const chatMessages: ChatMessageRecord[] = [];
  const bannedIps = new Set<string>();
  let clock = 1_000;
  let nextId = 0;

  const send = (ws: WebSocket, message: ServerMessage) => (ws as unknown as FakeSocket).received.push(message);

  const ctx: RoomContext = {
    meta,
    now: () => clock,
    peers: () => registry,
    peerByClientId: (clientId) => registry.find((p) => p.attachment.clientId === clientId),
    send,
    broadcast: (message, exceptWs) => {
      for (const p of registry) if (p.ws !== exceptWs) send(p.ws, message);
    },
    saveMeta: () => {},
    generateId: () => `id-${nextId++}`,
    closePeer: (ws, code, reason) => ((ws as unknown as FakeSocket).closed = { code, reason }),
    chatHistory: {
      append: (message) => chatMessages.push(message),
      recent: () => chatMessages
    },
    bans: {
      isBanned: (ip) => bannedIps.has(ip),
      ban: (ip) => bannedIps.add(ip)
    }
  };

  function connect(
    clientId: string,
    role: PeerAttachment["role"],
    name = role,
    ip = "1.2.3.4"
  ): { ws: FakeSocket; attachment: PeerAttachment } {
    const ws = new FakeSocket();
    const attachment: PeerAttachment = { clientId, role, name, joinedAt: clock, lastSeenAt: clock, ip };
    registry.push({ ws: ws as unknown as WebSocket, attachment });
    return { ws, attachment };
  }

  // Mirrors the real Durable Object: by the time webSocketClose/handleLeave
  // runs, the closing socket is no longer in the live peer list.
  function disconnect(clientId: string): void {
    const idx = registry.findIndex((p) => p.attachment.clientId === clientId);
    if (idx !== -1) registry.splice(idx, 1);
  }

  return { ctx, meta, registry, connect, disconnect, advanceClock: (ms: number) => (clock += ms) };
}

describe("presence handlers", () => {
  // Mirrors what the real Durable Object does: build the attachment, attach
  // it to the socket, *then* announce — see assignRole's doc comment for why
  // that order matters.
  function joinAsNewPeer(
    ctx: RoomContext,
    registry: Array<{ ws: WebSocket; attachment: PeerAttachment }>,
    clientId: string,
    name?: string,
    ip = "1.2.3.4"
  ) {
    const ws = new FakeSocket();
    const attachment = assignRole(ctx, clientId, name, ip);
    registry.push({ ws: ws as unknown as WebSocket, attachment });
    announceJoin(ctx, ws as unknown as WebSocket, attachment);
    return { ws, attachment };
  }

  it("makes the first joiner the host", () => {
    const { ctx, registry } = createFakeContext();
    const { ws, attachment } = joinAsNewPeer(ctx, registry, "client-1", "Alice");
    expect(attachment.role).toBe("host");
    expect(ctx.meta.hostClientId).toBe("client-1");
    expect(ws.received[0]).toMatchObject({ type: "state", host: true });
  });

  it("makes later joiners viewers and notifies existing peers, not the joiner", () => {
    const { ctx, registry, connect } = createFakeContext({ hostClientId: "client-1" });
    connect("client-1", "host");
    const { ws, attachment } = joinAsNewPeer(ctx, registry, "client-2", "Bob");
    expect(attachment.role).toBe("viewer");
    expect(ws.received.some((m) => m.type === "presence")).toBe(false);
  });

  it("regression: the host's presence broadcast includes the peer who just joined", () => {
    // Bug caught during live testing: if the attachment is serialized onto
    // the socket *after* the join is announced, the new joiner is invisible
    // to its own join broadcast because ctx.peers() reads attachments live.
    const { ctx, registry } = createFakeContext();
    const host = joinAsNewPeer(ctx, registry, "client-1", "Alice");
    const viewer = joinAsNewPeer(ctx, registry, "client-2", "Bob");

    const lastPresenceToHost = host.ws.received.filter((m) => m.type === "presence").at(-1);
    expect(lastPresenceToHost).toEqual({
      type: "presence",
      peers: [
        { clientId: "client-1", role: "host", name: "Alice" },
        { clientId: "client-2", role: "viewer", name: "Bob" }
      ]
    });
    void viewer;
  });

  it("hands the host role to the next peer when the host leaves", () => {
    const { ctx, connect, disconnect } = createFakeContext({ hostClientId: "client-1" });
    const host = connect("client-1", "host");
    const viewer = connect("client-2", "viewer");
    disconnect("client-1");

    handleLeave(ctx, host.attachment);

    expect(ctx.meta.hostClientId).toBe("client-2");
    expect(viewer.ws.received).toContainEqual({ type: "hostChanged", hostClientId: "client-2" });
    expect(viewer.ws.received).toContainEqual({ type: "presence", peers: [{ clientId: "client-2", role: "host", name: "viewer" }] });
  });

  it("clears the room when the last peer (the host) leaves", () => {
    const { ctx, connect, disconnect } = createFakeContext({ hostClientId: "client-1" });
    const host = connect("client-1", "host");
    disconnect("client-1");

    handleLeave(ctx, host.attachment);

    expect(ctx.meta.hostClientId).toBeNull();
  });

  it("does nothing but re-broadcast presence when a non-host leaves", () => {
    const { ctx, connect, disconnect } = createFakeContext({ hostClientId: "client-1" });
    const host = connect("client-1", "host");
    const viewer = connect("client-2", "viewer");
    disconnect("client-2");

    handleLeave(ctx, viewer.attachment);

    expect(ctx.meta.hostClientId).toBe("client-1");
    expect(host.ws.received).toContainEqual({ type: "presence", peers: [{ clientId: "client-1", role: "host", name: "host" }] });
  });
});

describe("control handlers", () => {
  it("only the host can toggle guest control", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1" });
    const viewer = connect("viewer-1", "viewer");
    handleControlAccess(ctx, viewer.attachment, true);
    expect(ctx.meta.allowGuestControl).toBe(false);

    const host = connect("host-1", "host");
    handleControlAccess(ctx, host.attachment, true);
    expect(ctx.meta.allowGuestControl).toBe(true);
  });

  it("routes a viewer's control request only to the host, never back to the sender", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1", allowGuestControl: true });
    const host = connect("host-1", "host");
    const viewer = connect("viewer-1", "viewer");

    handleControlRequest(ctx, viewer.attachment, { type: "controlRequest", action: "play", position: 42 });

    expect(host.ws.received).toEqual([{ type: "controlRequest", from: "viewer-1", action: "play", position: 42 }]);
    expect(viewer.ws.received).toEqual([]); // the bug from the audit: sender must never see its own request
  });

  it("drops guest control requests when the host has not allowed them", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1", allowGuestControl: false });
    const host = connect("host-1", "host");
    const viewer = connect("viewer-1", "viewer");

    handleControlRequest(ctx, viewer.attachment, { type: "controlRequest", action: "pause" });

    expect(host.ws.received).toEqual([]);
  });

  it("ignores a host sending itself a control request", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1", allowGuestControl: true });
    const host = connect("host-1", "host");
    handleControlRequest(ctx, host.attachment, { type: "controlRequest", action: "seek", position: 10 });
    expect(host.ws.received).toEqual([]);
  });

  it("broadcasts the host's position to everyone else, not back to the host", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1" });
    const host = connect("host-1", "host");
    const viewer = connect("viewer-1", "viewer");

    handlePositionUpdate(ctx, host.attachment, 123.4, true, 5400);

    expect(viewer.ws.received).toEqual([
      { type: "positionSync", position: 123.4, playing: true, duration: 5400, serverTime: 1000 }
    ]);
    expect(host.ws.received).toEqual([]);
  });

  it("ignores a position update from a non-host", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1" });
    connect("host-1", "host");
    const viewer = connect("viewer-1", "viewer");

    handlePositionUpdate(ctx, viewer.attachment, 5, false, null);

    expect(viewer.ws.received).toEqual([]);
  });
});

describe("signaling handlers", () => {
  it("relays an offer only to its target", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1" });
    const host = connect("host-1", "host");
    const viewerA = connect("viewer-a", "viewer");
    const viewerB = connect("viewer-b", "viewer");

    handleRtcRelay(ctx, host.attachment, {
      type: "rtcOffer",
      targetId: "viewer-a",
      sdp: { type: "offer", sdp: "v=0" },
      purpose: "video"
    });

    expect(viewerA.ws.received).toEqual([
      { type: "rtcOffer", fromId: "host-1", sdp: { type: "offer", sdp: "v=0" }, purpose: "video" }
    ]);
    expect(viewerB.ws.received).toEqual([]);
  });

  it("only the host can announce source readiness", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1" });
    const viewer = connect("viewer-1", "viewer");
    handleSourceReady(ctx, viewer.attachment, true);
    expect(ctx.meta.hasActiveSource).toBe(false);
  });

  it("drops voice signaling when voice is disabled, but still relays video", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1", voiceEnabled: false });
    const host = connect("host-1", "host");
    const viewer = connect("viewer-1", "viewer");

    handleRtcRelay(ctx, host.attachment, {
      type: "rtcOffer",
      targetId: "viewer-1",
      sdp: { type: "offer", sdp: "v=0" },
      purpose: "voice"
    });
    expect(viewer.ws.received).toEqual([]);

    handleRtcRelay(ctx, host.attachment, {
      type: "rtcOffer",
      targetId: "viewer-1",
      sdp: { type: "offer", sdp: "v=0" },
      purpose: "video"
    });
    expect(viewer.ws.received).toHaveLength(1);
  });
});

describe("chat handler", () => {
  it("broadcasts to everyone including the sender", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1" });
    const host = connect("host-1", "host");
    const viewer = connect("viewer-1", "viewer");
    handleChat(ctx, viewer.attachment, "hi everyone");
    expect(host.ws.received).toHaveLength(1);
    expect(viewer.ws.received).toHaveLength(1);
    expect(viewer.ws.received[0]).toMatchObject({ type: "chat", senderId: "viewer-1", body: "hi everyone" });
  });

  it("is silently dropped when chat is disabled", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1", chatEnabled: false });
    const viewer = connect("viewer-1", "viewer");
    handleChat(ctx, viewer.attachment, "hi");
    expect(viewer.ws.received).toEqual([]);
  });
});

describe("join gate", () => {
  it("rejects a banned IP", () => {
    const { ctx } = createFakeContext();
    ctx.bans.ban("9.9.9.9", "Troll");
    expect(checkJoinAllowed(ctx, "9.9.9.9")).toEqual({ allowed: false, reason: "You are banned from this room." });
  });

  it("rejects new viewers when locked and a host is present", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1", locked: true });
    connect("host-1", "host");
    expect(checkJoinAllowed(ctx, "1.2.3.4")).toEqual({ allowed: false, reason: "This room is locked." });
  });

  it("still allows a join when locked but no host is currently present", () => {
    const { ctx } = createFakeContext({ hostClientId: null, locked: true });
    expect(checkJoinAllowed(ctx, "1.2.3.4")).toEqual({ allowed: true });
  });

  it("rejects joins once maxPeers is reached", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1", maxPeers: 1 });
    connect("host-1", "host");
    expect(checkJoinAllowed(ctx, "5.5.5.5")).toEqual({ allowed: false, reason: "This room is full." });
  });

  it("allows joins under an unlimited or unmet cap", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1", maxPeers: 2 });
    connect("host-1", "host");
    expect(checkJoinAllowed(ctx, "5.5.5.5")).toEqual({ allowed: true });
  });
});

describe("moderation handlers", () => {
  it("lets the host kick a viewer, who may still rejoin later", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1" });
    const host = connect("host-1", "host");
    const viewer = connect("viewer-1", "viewer", "viewer", "6.6.6.6");

    handleKick(ctx, host.attachment, "viewer-1");

    expect(viewer.ws.received).toContainEqual({ type: "kicked", reason: "The host removed you from the room." });
    expect(viewer.ws.closed).toEqual({ code: 4001, reason: "kicked" });
    expect(ctx.bans.isBanned("6.6.6.6")).toBe(false);
  });

  it("lets the host ban a viewer, blocking their IP from rejoining", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1" });
    const host = connect("host-1", "host");
    const viewer = connect("viewer-1", "viewer", "viewer", "6.6.6.6");

    handleBan(ctx, host.attachment, "viewer-1");

    expect(viewer.ws.received).toContainEqual({ type: "banned", reason: "The host banned you from this room." });
    expect(ctx.bans.isBanned("6.6.6.6")).toBe(true);
  });

  it("prevents a viewer from kicking or banning anyone", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1" });
    connect("host-1", "host");
    const viewerA = connect("viewer-a", "viewer");
    const viewerB = connect("viewer-b", "viewer", "viewer", "7.7.7.7");

    handleKick(ctx, viewerA.attachment, "viewer-b");
    handleBan(ctx, viewerA.attachment, "viewer-b");

    expect(viewerB.ws.received).toEqual([]);
    expect(viewerB.ws.closed).toBeNull();
    expect(ctx.bans.isBanned("7.7.7.7")).toBe(false);
  });

  it("prevents the host from kicking or banning themselves", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1" });
    const host = connect("host-1", "host");
    handleKick(ctx, host.attachment, "host-1");
    handleBan(ctx, host.attachment, "host-1");
    expect(host.ws.closed).toBeNull();
  });

  it("lets the host update room settings and broadcasts the merged result", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1" });
    const host = connect("host-1", "host");
    const viewer = connect("viewer-1", "viewer");

    handleRoomSettings(ctx, host.attachment, { locked: true, maxPeers: 5 });

    expect(ctx.meta.locked).toBe(true);
    expect(ctx.meta.maxPeers).toBe(5);
    expect(ctx.meta.chatEnabled).toBe(true); // untouched fields keep their value
    expect(viewer.ws.received).toContainEqual({
      type: "roomSettings",
      locked: true,
      maxPeers: 5,
      chatEnabled: true,
      voiceEnabled: true
    });
  });

  it("ignores room settings changes from a non-host", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1" });
    connect("host-1", "host");
    const viewer = connect("viewer-1", "viewer");

    handleRoomSettings(ctx, viewer.attachment, { locked: true });

    expect(ctx.meta.locked).toBe(false);
  });
});

describe("subtitle sharing", () => {
  it("lets the host share a subtitle file, broadcast to everyone but the sender", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1" });
    const host = connect("host-1", "host");
    const viewer = connect("viewer-1", "viewer");

    handleSubtitleShare(ctx, host.attachment, { name: "movie.srt", content: "1\n00:00:01,000 --> 00:00:02,000\nHi\n" });

    expect(ctx.meta.sharedSubtitle).toEqual({ name: "movie.srt", content: "1\n00:00:01,000 --> 00:00:02,000\nHi\n" });
    expect(viewer.ws.received).toEqual([
      { type: "subtitleShare", name: "movie.srt", content: "1\n00:00:01,000 --> 00:00:02,000\nHi\n" }
    ]);
    expect(host.ws.received).toEqual([]);
  });

  it("ignores a subtitle share from a non-host", () => {
    const { ctx, connect } = createFakeContext({ hostClientId: "host-1" });
    connect("host-1", "host");
    const viewer = connect("viewer-1", "viewer");

    handleSubtitleShare(ctx, viewer.attachment, { name: "sneaky.srt", content: "nope" });

    expect(ctx.meta.sharedSubtitle).toBeNull();
  });
});

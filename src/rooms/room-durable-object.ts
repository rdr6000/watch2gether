import { DurableObject } from "cloudflare:workers";
import type { Env, PeerAttachment, RoomMeta, ServerMessage } from "./types";
import type { RoomContext } from "./room-context";
import { announceJoin, assignRole, checkJoinAllowed, dispatchMessage, handleLeave } from "./handlers";
import { MAX_RAW_MESSAGE_BYTES, parseClientMessage } from "./validation";
import { EMPTY_ROOM_GRACE_MS, HEARTBEAT_INTERVAL_MS, SOLO_HOST_TIMEOUT_MS, partitionPeersByLiveness } from "./gc";
import { RateLimiter } from "./rate-limiter";
import { ChatStore } from "./chat-store";
import { BanStore } from "./ban-store";
import { migrateRoomMetaTable } from "./schema";

interface RoomMetaRow extends Record<string, SqlStorageValue> {
  room_id: string;
  host_client_id: string | null;
  allow_guest_control: number;
  created_at: number;
  locked: number;
  max_peers: number | null;
  chat_enabled: number;
  voice_enabled: number;
  ever_had_second_peer: number;
  shared_subtitle_name: string | null;
  shared_subtitle_content: string | null;
}

/** The only shape stored on a socket before it completes a "join" — see fetch(). */
interface PendingAttachment {
  ip: string;
}

function defaultMeta(): RoomMeta {
  return {
    roomId: "",
    hostClientId: null,
    allowGuestControl: false,
    hasActiveSource: false,
    createdAt: Date.now(),
    locked: false,
    maxPeers: null,
    chatEnabled: true,
    voiceEnabled: true,
    emptySince: null,
    everHadSecondPeer: false,
    sharedSubtitle: null
  };
}

function isFullAttachment(attachment: PendingAttachment | PeerAttachment | null): attachment is PeerAttachment {
  return attachment !== null && "clientId" in attachment;
}

/**
 * One instance per room (addressed via ROOM_DO.getByName(roomCode)).
 * Holds room state in SQLite (survives hibernation/eviction) and every
 * connected WebSocket via the Hibernation API (survives idle periods with
 * zero compute billing). Message handling itself lives in ./handlers —
 * this class is wiring only, kept intentionally thin.
 */
export class RoomDurableObject extends DurableObject<Env> {
  /** Not persisted across hibernation on purpose — resets to a fresh window, which is fine (see rate-limiter.ts). */
  private rateLimiters = new WeakMap<WebSocket, RateLimiter>();
  private chatStore: ChatStore;
  private banStore: BanStore;

  private meta: RoomMeta = defaultMeta();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.chatStore = new ChatStore(ctx.storage.sql);
    this.banStore = new BanStore(ctx.storage.sql);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room_meta (
          id INTEGER PRIMARY KEY CHECK (id = 0),
          room_id TEXT NOT NULL,
          host_client_id TEXT,
          allow_guest_control INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          locked INTEGER NOT NULL DEFAULT 0,
          max_peers INTEGER,
          chat_enabled INTEGER NOT NULL DEFAULT 1,
          voice_enabled INTEGER NOT NULL DEFAULT 1,
          ever_had_second_peer INTEGER NOT NULL DEFAULT 0,
          shared_subtitle_name TEXT,
          shared_subtitle_content TEXT
        )
      `);
      migrateRoomMetaTable(this.ctx.storage.sql);
      const rows = this.ctx.storage.sql.exec<RoomMetaRow>("SELECT * FROM room_meta WHERE id = 0").toArray();
      const row = rows[0];
      if (row) {
        this.meta = {
          roomId: row.room_id,
          hostClientId: row.host_client_id,
          allowGuestControl: Boolean(row.allow_guest_control),
          hasActiveSource: false,
          createdAt: row.created_at,
          locked: Boolean(row.locked),
          maxPeers: row.max_peers,
          chatEnabled: Boolean(row.chat_enabled),
          voiceEnabled: Boolean(row.voice_enabled),
          emptySince: null,
          everHadSecondPeer: Boolean(row.ever_had_second_peer),
          sharedSubtitle:
            row.shared_subtitle_name !== null && row.shared_subtitle_content !== null
              ? { name: row.shared_subtitle_name, content: row.shared_subtitle_content }
              : null
        };
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!this.meta.roomId) {
      this.meta.roomId = (url.searchParams.get("room") || "").toUpperCase();
      this.meta.createdAt = Date.now();
      this.saveMeta();
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade.", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    // Preliminary attachment — just enough to identify the connection for a ban check
    // once it sends "join". Replaced with a full PeerAttachment in webSocketMessage.
    server.serializeAttachment({ ip: request.headers.get("cf-connecting-ip") || "unknown" } satisfies PendingAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_RAW_MESSAGE_BYTES) return;

    const now = Date.now();
    let limiter = this.rateLimiters.get(ws);
    if (!limiter) {
      limiter = new RateLimiter(60, 10_000, now);
      this.rateLimiters.set(ws, limiter);
    }
    if (!limiter.allow(now)) return; // sustained flood — drop silently, connection stays open

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const msg = parseClientMessage(parsed);
    if (!msg) return;

    const attached = ws.deserializeAttachment() as PendingAttachment | PeerAttachment | null;
    const roomCtx = this.buildContext();

    if (!isFullAttachment(attached)) {
      if (msg.type !== "join") return;
      const ip = attached?.ip ?? "unknown";

      const decision = checkJoinAllowed(roomCtx, ip);
      if (!decision.allowed) {
        roomCtx.send(ws, { type: "error", message: decision.reason });
        ws.close(4003, "join-denied");
        return;
      }

      const clientId = crypto.randomUUID();
      const attachment = assignRole(roomCtx, clientId, msg.name, ip);
      ws.serializeAttachment(attachment); // must happen before announceJoin — see assignRole's doc comment
      announceJoin(roomCtx, ws, attachment);
      await this.ensureAlarmScheduled();
      return;
    }

    ws.serializeAttachment({ ...attached, lastSeenAt: now });
    dispatchMessage(roomCtx, attached, msg);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.rateLimiters.delete(ws);
    const attached = ws.deserializeAttachment() as PendingAttachment | PeerAttachment | null;
    if (!isFullAttachment(attached)) return;
    handleLeave(this.buildContext(ws), attached);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /**
   * One alarm, three jobs, all on the same ~30s cadence:
   *  1. If the room's been empty past the grace period, wipe its storage.
   *  2. If the host has been alone past the solo timeout, close them out too
   *     (bounds the lifetime of an abandoned open connection — see README).
   *  3. Otherwise, heartbeat: ping live peers, drop stale ones.
   * Reschedules itself only while there's still something to watch.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    const roomCtx = this.buildContext();
    const currentPeers = roomCtx.peers();

    if (currentPeers.length === 0) {
      if (this.meta.emptySince !== null && now - this.meta.emptySince >= EMPTY_ROOM_GRACE_MS) {
        this.destroyRoom();
        return;
      }
      await this.ctx.storage.setAlarm((this.meta.emptySince ?? now) + EMPTY_ROOM_GRACE_MS);
      return;
    }

    const lonelyHost = currentPeers.length === 1 ? currentPeers[0] : undefined;
    if (lonelyHost && !this.meta.everHadSecondPeer && now - this.meta.createdAt >= SOLO_HOST_TIMEOUT_MS) {
      roomCtx.send(lonelyHost.ws, { type: "roomExpired", reason: "No one joined within 5 minutes." });
      lonelyHost.ws.close(4002, "expired");
      this.destroyRoom();
      return;
    }

    const { alive, stale } = partitionPeersByLiveness(
      currentPeers.map((p) => p.attachment),
      now
    );
    const staleIds = new Set(stale.map((p) => p.clientId));

    for (const peer of currentPeers) {
      if (staleIds.has(peer.attachment.clientId)) peer.ws.close(1000, "timeout");
      else roomCtx.send(peer.ws, { type: "ping" });
    }

    if (alive.length > 0) {
      await this.ctx.storage.setAlarm(now + HEARTBEAT_INTERVAL_MS);
    }
  }

  private async ensureAlarmScheduled(): Promise<void> {
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm === null) {
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
    }
  }

  /** Wipes room state entirely — the next join starts completely fresh, same as a brand-new room code. */
  private destroyRoom(): void {
    this.ctx.storage.sql.exec("DELETE FROM room_meta");
    this.ctx.storage.sql.exec("DELETE FROM chat_messages");
    this.ctx.storage.sql.exec("DELETE FROM bans");
    this.meta = { ...defaultMeta(), roomId: this.meta.roomId };
  }

  private saveMeta(): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO room_meta (id, room_id, host_client_id, allow_guest_control, created_at, locked, max_peers, chat_enabled, voice_enabled, ever_had_second_peer, shared_subtitle_name, shared_subtitle_content)
       VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         room_id = excluded.room_id,
         host_client_id = excluded.host_client_id,
         allow_guest_control = excluded.allow_guest_control,
         locked = excluded.locked,
         max_peers = excluded.max_peers,
         chat_enabled = excluded.chat_enabled,
         voice_enabled = excluded.voice_enabled,
         ever_had_second_peer = excluded.ever_had_second_peer,
         shared_subtitle_name = excluded.shared_subtitle_name,
         shared_subtitle_content = excluded.shared_subtitle_content`,
      this.meta.roomId,
      this.meta.hostClientId,
      this.meta.allowGuestControl ? 1 : 0,
      this.meta.createdAt,
      this.meta.locked ? 1 : 0,
      this.meta.maxPeers,
      this.meta.chatEnabled ? 1 : 0,
      this.meta.voiceEnabled ? 1 : 0,
      this.meta.everHadSecondPeer ? 1 : 0,
      this.meta.sharedSubtitle?.name ?? null,
      this.meta.sharedSubtitle?.content ?? null
    );
  }

  /** excludeWs: the socket currently being closed (not yet dropped from getWebSockets() in every case). */
  private buildContext(excludeWs?: WebSocket): RoomContext {
    const listPeers = () =>
      this.ctx
        .getWebSockets()
        .filter((w) => w !== excludeWs)
        .map((w) => ({ ws: w, attachment: w.deserializeAttachment() as PendingAttachment | PeerAttachment | null }))
        .filter((p): p is { ws: WebSocket; attachment: PeerAttachment } => isFullAttachment(p.attachment));

    const send = (ws: WebSocket, message: ServerMessage) => {
      try {
        ws.send(JSON.stringify(message));
      } catch {
        // socket already gone; the close/error handler will clean it up
      }
    };

    return {
      meta: this.meta,
      now: () => Date.now(),
      peers: listPeers,
      peerByClientId: (clientId) => listPeers().find((p) => p.attachment.clientId === clientId),
      send,
      broadcast: (message, exceptWs) => {
        for (const p of listPeers()) {
          if (p.ws !== exceptWs) send(p.ws, message);
        }
      },
      saveMeta: () => this.saveMeta(),
      generateId: () => crypto.randomUUID(),
      closePeer: (ws, code, reason) => ws.close(code, reason),
      chatHistory: {
        append: (message) => this.chatStore.append(message),
        recent: () => this.chatStore.recent()
      },
      bans: {
        isBanned: (ip) => this.banStore.isBanned(ip),
        ban: (ip, name) => this.banStore.ban(ip, name)
      }
    };
  }
}

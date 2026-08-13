import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RoomDurableObject } from "../src/rooms/room-durable-object";
import { migrateRoomMetaTable } from "../src/rooms/schema";

/** Opens a room WebSocket and joins, resolving once the "state" message arrives. */
async function joinRoom(room: string, name: string): Promise<{ ws: WebSocket; state: Record<string, unknown> }> {
  const res = await SELF.fetch(`http://example.com/ws?room=${room}`, {
    headers: { Upgrade: "websocket" }
  });
  const ws = res.webSocket;
  if (!ws) throw new Error("Expected a WebSocket upgrade response.");
  ws.accept();

  const state = await new Promise<Record<string, unknown>>((resolve) => {
    ws.addEventListener("message", function onMessage(event: MessageEvent) {
      const msg = JSON.parse(event.data as string);
      if (msg.type === "state") {
        ws.removeEventListener("message", onMessage);
        resolve(msg);
      }
    });
    ws.send(JSON.stringify({ type: "join", room, name }));
  });

  return { ws, state };
}

function nextMessage(ws: WebSocket, matching: (msg: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.addEventListener("message", function onMessage(event: MessageEvent) {
      const msg = JSON.parse(event.data as string);
      if (matching(msg)) {
        ws.removeEventListener("message", onMessage);
        resolve(msg);
      }
    });
  });
}

describe("RoomDurableObject", () => {
  it("rejects a malformed room code before any WebSocket upgrade happens", async () => {
    const res = await SELF.fetch("http://example.com/ws?room=ab", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(400);
  });

  it("makes the first joiner host and later joiners viewers", async () => {
    const room = "INTGRTN1";
    const { state: hostState } = await joinRoom(room, "Alice");
    expect(hostState.host).toBe(true);

    const { state: viewerState } = await joinRoom(room, "Bob");
    expect(viewerState.host).toBe(false);
    expect(viewerState.allowGuestControl).toBe(false);
  });

  it("routes a control request from viewer to host only, once guest control is allowed", async () => {
    const room = "INTGRTN2";
    const { ws: hostWs } = await joinRoom(room, "Host");
    const { ws: viewerWs } = await joinRoom(room, "Viewer");

    hostWs.send(JSON.stringify({ type: "controlAccess", allow: true }));
    await nextMessage(viewerWs, (m) => m.type === "controlAccess");

    const hostSawRequest = nextMessage(hostWs, (m) => m.type === "controlRequest");
    const viewerEchoRace = nextMessage(viewerWs, (m) => m.type === "controlRequest");

    viewerWs.send(JSON.stringify({ type: "controlRequest", action: "play", position: 12.5 }));

    const received = await Promise.race([
      hostSawRequest.then((m) => ({ who: "host", m })),
      viewerEchoRace.then((m) => ({ who: "viewer", m }))
    ]);

    expect(received.who).toBe("host");
    expect(received.m).toMatchObject({ action: "play", position: 12.5 });
  });

  it("broadcasts chat to everyone and replays history to a later joiner", async () => {
    const room = "INTGRTNCHAT";
    const { ws: hostWs } = await joinRoom(room, "Host");

    hostWs.send(JSON.stringify({ type: "chat", body: "hello from host" }));
    const echoed = await nextMessage(hostWs, (m) => m.type === "chat");
    expect(echoed).toMatchObject({ senderName: "Host", body: "hello from host" });

    const { ws: viewerWs } = await joinRoom(room, "Viewer");
    const history = await nextMessage(viewerWs, (m) => m.type === "chatHistory");
    expect(history.messages).toMatchObject([{ senderName: "Host", body: "hello from host" }]);
  });

  it("broadcasts a host's shared subtitle and replays it to a later joiner", async () => {
    const room = "INTGRTNSUB";
    const { ws: hostWs } = await joinRoom(room, "Host");
    const { ws: viewerWs } = await joinRoom(room, "Viewer");

    const received = nextMessage(viewerWs, (m) => m.type === "subtitleShare");
    hostWs.send(JSON.stringify({ type: "subtitleShare", name: "movie.srt", content: "1\n00:00:01,000 --> 00:00:02,000\nHi\n" }));
    expect((await received).name).toBe("movie.srt");

    const { state: laterState } = await joinRoom(room, "LateJoiner");
    expect(laterState.sharedSubtitle).toEqual({ name: "movie.srt", content: "1\n00:00:01,000 --> 00:00:02,000\nHi\n" });
  });

  it("regression: persists a shared subtitle to SQLite so it survives a Durable Object eviction", async () => {
    // Caught live: the in-memory-only version of this feature passed every
    // test above (same DO instance, never evicted mid-test) but silently lost
    // the subtitle for any real joiner arriving after Miniflare/production
    // evicted and reconstructed the DO — because the handler never called
    // saveMeta(). Assert the actual row, not just same-instance behavior.
    const room = "INTGRTNSUBPERSIST";
    const { ws: hostWs } = await joinRoom(room, "Host");
    hostWs.send(JSON.stringify({ type: "subtitleShare", name: "movie.srt", content: "hello subs" }));
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the DO finish handling the message

    const stub = env.ROOM_DO.getByName(room);
    await runInDurableObject(stub, async (_instance: RoomDurableObject, state: DurableObjectState) => {
      const rows = state.storage.sql
        .exec<{ shared_subtitle_name: string | null; shared_subtitle_content: string | null }>(
          "SELECT shared_subtitle_name, shared_subtitle_content FROM room_meta WHERE id = 0"
        )
        .toArray();
      expect(rows[0]).toEqual({ shared_subtitle_name: "movie.srt", shared_subtitle_content: "hello subs" });
    });
  });

  it("promotes the next peer to host when the host disconnects", async () => {
    const room = "INTGRTN3";
    const { ws: hostWs } = await joinRoom(room, "Host");
    const { ws: viewerWs } = await joinRoom(room, "Viewer");

    const hostChanged = nextMessage(viewerWs, (m) => m.type === "hostChanged");
    hostWs.close();
    const msg = await hostChanged;
    expect(msg.hostClientId).toBeTruthy();
  });

  it("schedules a heartbeat alarm once a peer joins", async () => {
    const room = "INTGRTN4";
    await joinRoom(room, "Host");

    const stub = env.ROOM_DO.getByName(room);
    await runInDurableObject(stub, async (_instance: RoomDurableObject, state: DurableObjectState) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("pings a still-live peer on heartbeat instead of disconnecting it", async () => {
    const room = "INTGRTN5";
    const { ws } = await joinRoom(room, "Host");

    const stub = env.ROOM_DO.getByName(room);
    const ping = nextMessage(ws, (m) => m.type === "ping");
    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await ping; // resolves only if the socket is still open and got pinged, not closed
  });

  it("lets the host kick a viewer, and a banned viewer's rejoin is rejected", async () => {
    const room = "INTGRTNKICK";
    const { ws: hostWs } = await joinRoom(room, "Host");
    const { ws: viewerWs, state: viewerState } = await joinRoom(room, "Viewer");

    const kicked = nextMessage(viewerWs, (m) => m.type === "kicked");
    hostWs.send(JSON.stringify({ type: "kickPeer", clientId: viewerState.clientId }));
    expect((await kicked).reason).toBeTruthy();

    // Kicked (not banned) — rejoining the same room succeeds.
    const { state: rejoinState } = await joinRoom(room, "Viewer");
    expect(rejoinState.host).toBe(false);

    const { ws: viewer2Ws, state: viewer2State } = await joinRoom(room, "Viewer2");
    const banned = nextMessage(viewer2Ws, (m) => m.type === "banned");
    hostWs.send(JSON.stringify({ type: "banPeer", clientId: viewer2State.clientId }));
    expect((await banned).reason).toBeTruthy();

    const res = await SELF.fetch(`http://example.com/ws?room=${room}`, { headers: { Upgrade: "websocket" } });
    const retryWs = res.webSocket!;
    retryWs.accept();
    const denied = await new Promise<Record<string, unknown>>((resolve) => {
      retryWs.addEventListener("message", (event) => resolve(JSON.parse((event as MessageEvent).data as string)));
      retryWs.send(JSON.stringify({ type: "join", room }));
    });
    expect(denied).toMatchObject({ type: "error", message: "You are banned from this room." });
  });

  it("lets the host lock the room, update settings, and enforce max capacity", async () => {
    const room = "INTGRTNLOCK";
    const { ws: hostWs } = await joinRoom(room, "Host");
    const { ws: viewerWs } = await joinRoom(room, "Viewer");

    const settingsUpdate = nextMessage(viewerWs, (m) => m.type === "roomSettings");
    hostWs.send(JSON.stringify({ type: "roomSettings", locked: true, maxPeers: 2 }));
    const settings = await settingsUpdate;
    expect(settings).toMatchObject({ locked: true, maxPeers: 2 });

    const res = await SELF.fetch(`http://example.com/ws?room=${room}`, { headers: { Upgrade: "websocket" } });
    const rejectedWs = res.webSocket!;
    rejectedWs.accept();
    const denied = await new Promise<Record<string, unknown>>((resolve) => {
      rejectedWs.addEventListener("message", (event) => resolve(JSON.parse((event as MessageEvent).data as string)));
      rejectedWs.send(JSON.stringify({ type: "join", room }));
    });
    expect(denied).toMatchObject({ type: "error", message: "This room is locked." });
  });

  it("auto-destroys a room once it has been empty past the grace period", async () => {
    const room = "INTGRTNEMPTY";
    const { ws } = await joinRoom(room, "Host");
    ws.close();

    const stub = env.ROOM_DO.getByName(room);
    await runInDurableObject(stub, async (instance: RoomDurableObject, state: DurableObjectState) => {
      // Fast-forward past the grace period without waiting for real time to pass.
      (instance as unknown as { meta: { emptySince: number } }).meta.emptySince = Date.now() - 10 * 60_000;
      void state;
    });
    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (_instance: RoomDurableObject, state: DurableObjectState) => {
      const rows = state.storage.sql.exec("SELECT * FROM room_meta").toArray();
      expect(rows).toHaveLength(0);
    });
  });

  it("closes and destroys a room where no one ever joined the solo host within the timeout", async () => {
    const room = "INTGRTNSOLO";
    const { ws } = await joinRoom(room, "Host");

    const stub = env.ROOM_DO.getByName(room);
    await runInDurableObject(stub, async (instance: RoomDurableObject) => {
      (instance as unknown as { meta: { createdAt: number } }).meta.createdAt = Date.now() - 10 * 60_000;
    });

    const expired = nextMessage(ws, (m) => m.type === "roomExpired");
    await runDurableObjectAlarm(stub);
    expect((await expired).reason).toBeTruthy();

    await runInDurableObject(stub, async (_instance: RoomDurableObject, state: DurableObjectState) => {
      const rows = state.storage.sql.exec("SELECT * FROM room_meta").toArray();
      expect(rows).toHaveLength(0);
    });
  });

  it("regression: migrates a room_meta table created under an older schema instead of crashing", async () => {
    // Reproduces a real bug caught in manual testing: local dev storage (and
    // production storage for any room that existed before a deploy) keeps
    // whatever columns room_meta had when it was first created — a later
    // CREATE TABLE IF NOT EXISTS is a no-op against an existing table, so
    // without an explicit migration, saveMeta() crashes with "no column
    // named locked" the moment a room created under the old schema is used.
    const room = "INTGRTNMIGRATE";
    await joinRoom(room, "Host");

    const stub = env.ROOM_DO.getByName(room);
    await runInDurableObject(stub, async (_instance: RoomDurableObject, state: DurableObjectState) => {
      state.storage.sql.exec("DROP TABLE room_meta");
      state.storage.sql.exec(`
        CREATE TABLE room_meta (
          id INTEGER PRIMARY KEY CHECK (id = 0),
          room_id TEXT NOT NULL,
          host_client_id TEXT,
          allow_guest_control INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        )
      `);
      state.storage.sql.exec(
        "INSERT INTO room_meta (id, room_id, host_client_id, allow_guest_control, created_at) VALUES (0, ?, NULL, 0, ?)",
        room,
        Date.now()
      );

      // The exact call the constructor makes on every DO startup, run here
      // against the pre-existing old-schema table instead of a fresh one.
      migrateRoomMetaTable(state.storage.sql);

      const columns = state.storage.sql.exec<{ name: string }>("PRAGMA table_info(room_meta)").toArray();
      const columnNames = columns.map((c) => c.name);
      for (const expected of ["locked", "max_peers", "chat_enabled", "voice_enabled", "ever_had_second_peer"]) {
        expect(columnNames).toContain(expected);
      }

      // Proves the migrated columns are actually usable, not just present —
      // this is the exact statement that crashed with "no column named locked".
      expect(() =>
        state.storage.sql.exec(
          `INSERT INTO room_meta (id, room_id, host_client_id, allow_guest_control, created_at, locked, max_peers, chat_enabled, voice_enabled, ever_had_second_peer)
           VALUES (0, ?, NULL, 0, ?, 0, NULL, 1, 1, 0)
           ON CONFLICT(id) DO UPDATE SET locked = excluded.locked`,
          room,
          Date.now()
        )
      ).not.toThrow();
    });
  });

  it("rejects an oversized raw message instead of parsing it", async () => {
    const room = "INTGRTN6";
    const { ws } = await joinRoom(room, "Host");
    const tooLarge = JSON.stringify({ type: "chat", body: "x".repeat(400_000) });

    // Asserting on the absence of a response would be flaky; instead confirm the
    // payload is actually over the guard's threshold (raised to fit a shared
    // subtitle file — see MAX_RAW_MESSAGE_BYTES), then prove the connection
    // survives sending it (a smaller follow-up message still gets echoed back).
    expect(tooLarge.length).toBeGreaterThan(320 * 1024);
    ws.send(tooLarge);
    ws.send(JSON.stringify({ type: "chat", body: "still alive" }));
    const echoed = await nextMessage(ws, (m) => m.type === "chat");
    expect(echoed.body).toBe("still alive"); // the connection survived the oversized message
  });
});

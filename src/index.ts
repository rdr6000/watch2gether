import { RoomDurableObject } from "./rooms/room-durable-object";
import type { Env } from "./rooms/types";
import { isValidRoomCode, normalizeRoomCode } from "../public/shared/room-code.js";

export { RoomDurableObject };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade.", { status: 426 });
      }
      const room = normalizeRoomCode(url.searchParams.get("room"));
      if (!isValidRoomCode(room)) {
        return new Response("Invalid room code.", { status: 400 });
      }
      const stub = env.ROOM_DO.getByName(room);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;

import type { PeerAttachment } from "./types";

export const HEARTBEAT_INTERVAL_MS = 30_000;
/** Two missed heartbeats plus slack for network jitter before a peer is considered dead. */
export const STALE_PEER_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 2 + 5_000;
/** How long a room may sit at zero peers before its storage is wiped. Covers a quick refresh/reconnect. */
export const EMPTY_ROOM_GRACE_MS = 2 * 60_000;
/** A room whose host is still waiting alone past this point is closed — bounds the cost/risk of an abandoned room. */
export const SOLO_HOST_TIMEOUT_MS = 5 * 60_000;

/**
 * Pure classification so the sweep logic is testable without a real alarm,
 * real sockets, or real time. lastSeenAt is refreshed on every inbound
 * message (see room-durable-object.ts), including "pong" replies to the
 * heartbeat this module drives.
 */
export function partitionPeersByLiveness(
  peers: PeerAttachment[],
  now: number,
  staleTimeoutMs: number = STALE_PEER_TIMEOUT_MS
): { alive: PeerAttachment[]; stale: PeerAttachment[] } {
  const alive: PeerAttachment[] = [];
  const stale: PeerAttachment[] = [];
  for (const peer of peers) {
    (now - peer.lastSeenAt > staleTimeoutMs ? stale : alive).push(peer);
  }
  return { alive, stale };
}

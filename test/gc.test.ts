import { describe, expect, it } from "vitest";
import { partitionPeersByLiveness, STALE_PEER_TIMEOUT_MS } from "../src/rooms/gc";
import type { PeerAttachment } from "../src/rooms/types";

function peer(clientId: string, lastSeenAt: number): PeerAttachment {
  return { clientId, role: "viewer", name: clientId, joinedAt: 0, lastSeenAt, ip: "127.0.0.1" };
}

describe("partitionPeersByLiveness", () => {
  it("keeps a peer seen just now as alive", () => {
    const { alive, stale } = partitionPeersByLiveness([peer("a", 1000)], 1000);
    expect(alive.map((p) => p.clientId)).toEqual(["a"]);
    expect(stale).toEqual([]);
  });

  it("marks a peer past the stale timeout as stale", () => {
    const now = 100_000;
    const { alive, stale } = partitionPeersByLiveness([peer("a", now - STALE_PEER_TIMEOUT_MS - 1)], now);
    expect(alive).toEqual([]);
    expect(stale.map((p) => p.clientId)).toEqual(["a"]);
  });

  it("treats exactly-at-the-boundary as still alive", () => {
    const now = 100_000;
    const { alive, stale } = partitionPeersByLiveness([peer("a", now - STALE_PEER_TIMEOUT_MS)], now);
    expect(alive.map((p) => p.clientId)).toEqual(["a"]);
    expect(stale).toEqual([]);
  });

  it("classifies a mixed set correctly", () => {
    const now = 100_000;
    const { alive, stale } = partitionPeersByLiveness(
      [peer("fresh", now), peer("dead", now - STALE_PEER_TIMEOUT_MS - 10_000)],
      now
    );
    expect(alive.map((p) => p.clientId)).toEqual(["fresh"]);
    expect(stale.map((p) => p.clientId)).toEqual(["dead"]);
  });
});

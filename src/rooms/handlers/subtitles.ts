import type { RoomContext } from "../room-context";
import { isHost } from "../room-context";
import type { PeerAttachment, SharedSubtitle } from "../types";

/**
 * Host shares a subtitle file with the room. Persisted (like chat history,
 * unlike hasActiveSource) — a Durable Object can be evicted and reconstructed
 * between any two requests, and this needs to survive that so it can still be
 * replayed to a joiner who arrives after an eviction, not just one who
 * happens to arrive before the DO goes idle.
 */
export function handleSubtitleShare(ctx: RoomContext, from: PeerAttachment, subtitle: SharedSubtitle): void {
  if (!isHost(ctx, from.clientId)) return;
  // Callers pass the full incoming message (which also carries `type`); keep
  // only the fields SharedSubtitle actually declares so a stray `type` field
  // doesn't leak into stored room state (caught by a test asserting the
  // exact shape replayed to late joiners).
  const clean: SharedSubtitle = { name: subtitle.name, content: subtitle.content };
  ctx.meta.sharedSubtitle = clean;
  ctx.saveMeta();
  ctx.broadcast({ type: "subtitleShare", ...clean }, ctx.peerByClientId(from.clientId)?.ws);
}

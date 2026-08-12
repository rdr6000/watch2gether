/**
 * Fixed-window per-connection limiter. Deliberately permissive: WebRTC
 * signaling legitimately bursts (a batch of ICE candidates arrives at once),
 * so this exists to stop sustained flooding, not to police normal traffic.
 */
export class RateLimiter {
  #limit: number;
  #windowMs: number;
  #windowStart: number;
  #count = 0;

  constructor(limit = 60, windowMs = 10_000, now = 0) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#windowStart = now;
  }

  /** Returns false once the caller should start dropping messages for the rest of the window. */
  allow(now: number): boolean {
    if (now - this.#windowStart >= this.#windowMs) {
      this.#windowStart = now;
      this.#count = 0;
    }
    this.#count++;
    return this.#count <= this.#limit;
  }
}

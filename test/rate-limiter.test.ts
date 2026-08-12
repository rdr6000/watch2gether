import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/rooms/rate-limiter";

describe("RateLimiter", () => {
  it("allows messages up to the limit within a window", () => {
    const limiter = new RateLimiter(3, 1000, 0);
    expect(limiter.allow(0)).toBe(true);
    expect(limiter.allow(0)).toBe(true);
    expect(limiter.allow(0)).toBe(true);
  });

  it("blocks messages once the limit is exceeded within a window", () => {
    const limiter = new RateLimiter(3, 1000, 0);
    limiter.allow(0);
    limiter.allow(0);
    limiter.allow(0);
    expect(limiter.allow(0)).toBe(false);
    expect(limiter.allow(10)).toBe(false);
  });

  it("resets once the window elapses", () => {
    const limiter = new RateLimiter(2, 1000, 0);
    limiter.allow(0);
    limiter.allow(0);
    expect(limiter.allow(500)).toBe(false);
    expect(limiter.allow(1000)).toBe(true); // new window
    expect(limiter.allow(1000)).toBe(true);
    expect(limiter.allow(1000)).toBe(false);
  });
});

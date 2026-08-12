import { describe, expect, it } from "vitest";
import { SyncCorrector } from "../public/sync-corrector.js";

function fakeVideo(currentTime = 0) {
  return { currentTime, playbackRate: 1 };
}

describe("SyncCorrector", () => {
  it("establishes a baseline from the first sample instead of correcting against nothing", () => {
    const video = fakeVideo(0);
    const corrector = new SyncCorrector(video);
    corrector.onHostPosition(0.3, true); // this viewer's natural ~300ms latency
    expect(video.playbackRate).toBe(1);
    expect(corrector.currentDriftSeconds(0.3)).toBeCloseTo(0, 5);
  });

  it("does nothing while drift is within tolerance", () => {
    const video = fakeVideo(0);
    const corrector = new SyncCorrector(video);
    corrector.onHostPosition(0.3, true); // baseline = 0.3
    video.currentTime = 1.0;
    corrector.onHostPosition(1.35, true); // target = 1.05, actual 1.0 -> 0.05s error, within tolerance
    expect(video.playbackRate).toBe(1);
  });

  it("speeds up gently when falling behind its own baseline", () => {
    const video = fakeVideo(0);
    const corrector = new SyncCorrector(video);
    corrector.onHostPosition(0.3, true); // baseline = 0.3
    video.currentTime = 1.0;
    corrector.onHostPosition(2.0, true); // target = 1.7, actual 1.0 -> 0.7s behind
    expect(video.playbackRate).toBeGreaterThan(1);
    expect(video.playbackRate).toBeLessThanOrEqual(1.05);
  });

  it("slows down gently when running ahead of its own baseline", () => {
    const video = fakeVideo(0);
    const corrector = new SyncCorrector(video);
    corrector.onHostPosition(0.3, true); // baseline = 0.3
    video.currentTime = 2.0;
    corrector.onHostPosition(1.5, true); // target = 1.2, actual 2.0 -> 0.8s ahead
    expect(video.playbackRate).toBeLessThan(1);
    expect(video.playbackRate).toBeGreaterThanOrEqual(0.95);
  });

  it("never corrects beyond the +/-5% cap even for large drift", () => {
    const video = fakeVideo(0);
    const corrector = new SyncCorrector(video);
    corrector.onHostPosition(0, true);
    video.currentTime = 0.5;
    corrector.onHostPosition(2.5, true); // 2s of drift, still under the hard-resync threshold
    expect(video.playbackRate).toBe(1.05);
  });

  it("re-baselines instead of chasing a huge gap (a real stall, not jitter)", () => {
    const video = fakeVideo(0);
    const corrector = new SyncCorrector(video);
    corrector.onHostPosition(0, true); // baseline = 0
    video.currentTime = 1;
    corrector.onHostPosition(10, true); // 9s gap — a real stall, not jitter
    expect(video.playbackRate).toBe(1); // accepted as the new normal, not fought at 5%
    expect(corrector.currentDriftSeconds(10)).toBeCloseTo(0, 5);
  });

  it("holds normal speed while the host is paused", () => {
    const video = fakeVideo(0);
    const corrector = new SyncCorrector(video);
    corrector.onHostPosition(0.3, true);
    video.currentTime = 5;
    corrector.onHostPosition(1.0, false); // host paused — no correction should be attempted
    expect(video.playbackRate).toBe(1);
  });

  it("re-baselines on resume after a pause instead of treating elapsed local time as drift", () => {
    const video = fakeVideo(0);
    const corrector = new SyncCorrector(video);
    corrector.onHostPosition(0.3, true); // baseline = 0.3
    corrector.onHostPosition(0.3, false); // host pauses
    video.currentTime = 8; // local video clock keeps ticking on the frozen live frame while paused
    corrector.onHostPosition(0.3, true); // host resumes at the same position — should re-anchor, not panic-correct
    expect(video.playbackRate).toBe(1);
    expect(corrector.currentDriftSeconds(0.3)).toBeCloseTo(0, 5);
  });

  it("reset() clears the baseline for a fresh stream", () => {
    const video = fakeVideo(0);
    const corrector = new SyncCorrector(video);
    corrector.onHostPosition(0.3, true);
    corrector.reset();
    expect(video.playbackRate).toBe(1);
    expect(corrector.currentDriftSeconds(0.3)).toBeNull();
  });

  it("converges roughly proportionally to drift size within the capped range", () => {
    const video = fakeVideo(0);
    const corrector = new SyncCorrector(video);
    corrector.onHostPosition(0, true);
    video.currentTime = 0.8;
    corrector.onHostPosition(1.0, true); // 0.2s behind -> magnitude 0.02, under the cap
    expect(video.playbackRate).toBeCloseTo(1.02, 5);
  });
});

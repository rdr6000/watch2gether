import { describe, expect, it } from "vitest";
import { HostPositionClock } from "../public/position-clock.js";

describe("HostPositionClock", () => {
  it("holds steady while paused", () => {
    let now = 1000;
    const clock = new HostPositionClock(() => now);
    clock.update({ position: 42, playing: false });
    now += 5000;
    expect(clock.estimate()).toBe(42);
  });

  it("advances with elapsed wall time while playing", () => {
    let now = 1000;
    const clock = new HostPositionClock(() => now);
    clock.update({ position: 10, playing: true });
    now += 2500;
    expect(clock.estimate()).toBe(12.5);
  });

  it("re-anchors on each update", () => {
    let now = 1000;
    const clock = new HostPositionClock(() => now);
    clock.update({ position: 10, playing: true });
    now += 3000;
    clock.update({ position: 50, playing: true }); // e.g. the host seeked
    now += 1000;
    expect(clock.estimate()).toBe(51);
  });

  it("defaults to a stopped clock at position 0 before any update", () => {
    const clock = new HostPositionClock(() => 1000);
    expect(clock.estimate()).toBe(0);
  });
});

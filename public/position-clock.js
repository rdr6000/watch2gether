// Estimates the host's current playback position between positionSync
// messages, purely from wall-clock elapsed time since the last update.
// Precise enough for subtitle-cue timing and a scrub-bar readout; NOT used
// for playback control (the live captured stream is the actual playback).

export class HostPositionClock {
  #basePosition = 0;
  #baseAt;
  #playing = false;
  #now;

  constructor(now = () => Date.now()) {
    this.#now = now;
    this.#baseAt = now();
  }

  update({ position, playing }) {
    this.#basePosition = position;
    this.#baseAt = this.#now();
    this.#playing = playing;
  }

  estimate() {
    if (!this.#playing) return this.#basePosition;
    return this.#basePosition + (this.#now() - this.#baseAt) / 1000;
  }
}

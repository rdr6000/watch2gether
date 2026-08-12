// Keeps a viewer's live video locked to the host's real-time position over a
// long session, without ever pausing or seeking. WebRTC's jitter buffer can
// grow or shrink as network conditions change — left uncorrected, that shows
// up as slow drift away from the host (and from other viewers) over a long
// movie, worse the further apart people are. This corrects it with small,
// smooth playbackRate nudges instead: each viewer keeps whatever latency
// their own network naturally settles at (no point forcing someone on the
// same continent to match someone across the ocean), and only fights drift
// *away* from that baseline.
const CORRECTION_TOLERANCE_SEC = 0.15; // ignore drift smaller than this — avoids constant micro-adjustment
const MAX_CORRECTION_RATE = 0.05; // +/-5% playback speed — imperceptible to ear or eye
const HARD_RESYNC_THRESHOLD_SEC = 4; // beyond this, rate-correction would take too long; re-baseline instead

export class SyncCorrector {
  #video;
  #baselineLatency = null;
  #lastPlaying = null;

  /** video: anything with a readable .currentTime and a settable .playbackRate — a real <video> element or a fake in tests. */
  constructor(video) {
    this.#video = video;
  }

  /** Call on every host position update (position in seconds, playing state). */
  onHostPosition(hostPosition, playing) {
    const resuming = playing && this.#lastPlaying === false;
    this.#lastPlaying = playing;

    if (!playing) {
      this.#video.playbackRate = 1;
      return;
    }

    if (this.#baselineLatency === null || resuming) {
      this.#rebaseline(hostPosition);
      return;
    }

    const target = hostPosition - this.#baselineLatency;
    const error = target - this.#video.currentTime; // positive = falling behind

    if (Math.abs(error) > HARD_RESYNC_THRESHOLD_SEC) {
      this.#rebaseline(hostPosition); // a stall or missed re-anchor — accept the new normal rather than fight it
      return;
    }

    if (Math.abs(error) <= CORRECTION_TOLERANCE_SEC) {
      this.#video.playbackRate = 1;
      return;
    }

    const magnitude = Math.min(MAX_CORRECTION_RATE, Math.abs(error) / 10);
    this.#video.playbackRate = 1 + Math.sign(error) * magnitude;
  }

  /** A new stream arrived (host handoff, reconnect) — the old baseline is meaningless. */
  reset() {
    this.#baselineLatency = null;
    this.#lastPlaying = null;
    this.#video.playbackRate = 1;
  }

  /** Exposed for a UI indicator — null until a baseline exists. */
  currentDriftSeconds(hostPosition) {
    if (this.#baselineLatency === null) return null;
    return this.#video.currentTime - (hostPosition - this.#baselineLatency);
  }

  #rebaseline(hostPosition) {
    this.#baselineLatency = hostPosition - this.#video.currentTime;
    this.#video.playbackRate = 1;
  }
}

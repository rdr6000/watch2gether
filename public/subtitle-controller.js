import { parseSubtitles } from "./subtitles.js";
import { SubtitleOverlay } from "./subtitle-overlay.js";

/**
 * Wires a subtitle file picker to an overlay: parses the file once, then
 * samples getPositionSeconds() on an interval to keep the displayed cue in
 * sync. Reused for both the host (reads its own <video>.currentTime) and a
 * viewer (reads the estimated position from HostPositionClock) — same
 * behavior, different position source.
 */
export class SubtitleController {
  #overlay;
  #getPosition;
  #timer = null;

  constructor(containerEl, getPositionSeconds) {
    this.#overlay = new SubtitleOverlay(containerEl);
    this.#getPosition = getPositionSeconds;
  }

  async loadFile(file) {
    const text = await file.text();
    this.#overlay.setCues(parseSubtitles(text));
  }

  start() {
    this.stop();
    this.#timer = setInterval(() => this.#overlay.update(this.#getPosition()), 200);
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = null;
  }

  clear() {
    this.#overlay.clear();
  }
}

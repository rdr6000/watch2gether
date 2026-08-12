import { cueAt } from "./subtitles.js";

/** Renders the active subtitle cue as an overlay div positioned over a video container. */
export class SubtitleOverlay {
  #el;
  #cues = [];
  #lastText = null;

  constructor(containerEl) {
    this.#el = document.createElement("div");
    this.#el.className = "subtitle-overlay";
    this.#el.hidden = true;
    containerEl.appendChild(this.#el);
  }

  setCues(cues) {
    this.#cues = cues;
  }

  clear() {
    this.#cues = [];
    this.#paint(null);
  }

  /** Call on a timer (e.g. every 200ms) with the current estimated playback position. */
  update(timeSeconds) {
    const cue = this.#cues.length ? cueAt(this.#cues, timeSeconds) : null;
    const text = cue ? cue.text : null;
    if (text !== this.#lastText) this.#paint(text);
  }

  #paint(text) {
    this.#lastText = text;
    this.#el.hidden = text === null;
    this.#el.textContent = text ?? "";
  }
}

// Pure subtitle parsing — no DOM, no rendering. Supports .srt and .vtt.
// Rendering lives in subtitle-overlay.js.

function timestampToSeconds(raw) {
  const m = /(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{1,3})/.exec(raw.trim());
  if (!m) return null;
  const hours = m[1] ? Number(m[1].replace(":", "")) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const millis = Number(m[4].padEnd(3, "0"));
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/** Parses .srt or WebVTT text into a flat, time-sorted array of {start, end, text}. */
export function parseSubtitles(text) {
  const cleaned = text.replace(/^﻿/, "").replace(/\r/g, "");
  const blocks = cleaned.split(/\n\n+/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim() !== "" || cues.length === 0);
    if (lines.length === 0) continue;

    let start = 0;
    if (!lines[0].includes("-->")) start = 1; // skip a numeric index (SRT) or a cue identifier (VTT)
    const timingLine = lines[start];
    if (!timingLine || !timingLine.includes("-->")) continue;

    const [rawStart, rawEnd] = timingLine.split("-->");
    const startSec = timestampToSeconds(rawStart);
    const endSec = timestampToSeconds(rawEnd);
    if (startSec === null || endSec === null) continue;

    const text = lines
      .slice(start + 1)
      .join("\n")
      .trim();
    if (!text) continue;

    cues.push({ start: startSec, end: endSec, text });
  }

  return cues.sort((a, b) => a.start - b.start);
}

/** Binary search for the cue active at `timeSeconds`, or null between/after cues. */
export function cueAt(cues, timeSeconds) {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cue = cues[mid];
    if (timeSeconds < cue.start) hi = mid - 1;
    else if (timeSeconds > cue.end) lo = mid + 1;
    else return cue;
  }
  return null;
}

import { describe, expect, it } from "vitest";
import { cueAt, parseSubtitles } from "../public/subtitles.js";

const SRT = `1
00:00:01,000 --> 00:00:03,500
Hello there.

2
00:00:05,000 --> 00:00:07,000
General Kenobi.
`;

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.500
Hello there.

00:00:05.000 --> 00:00:07.000
General Kenobi.
`;

describe("parseSubtitles", () => {
  it("parses SRT timestamps and text", () => {
    const cues = parseSubtitles(SRT);
    expect(cues).toEqual([
      { start: 1, end: 3.5, text: "Hello there." },
      { start: 5, end: 7, text: "General Kenobi." }
    ]);
  });

  it("parses WebVTT timestamps and text, ignoring the header block", () => {
    const cues = parseSubtitles(VTT);
    expect(cues).toEqual([
      { start: 1, end: 3.5, text: "Hello there." },
      { start: 5, end: 7, text: "General Kenobi." }
    ]);
  });

  it("preserves multi-line cue text", () => {
    const cues = parseSubtitles("1\n00:00:00,000 --> 00:00:02,000\nLine one\nLine two\n");
    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe("Line one\nLine two");
  });

  it("skips malformed blocks instead of throwing", () => {
    const cues = parseSubtitles("garbage\nblock\n\n1\n00:00:01,000 --> 00:00:02,000\nOK\n");
    expect(cues).toEqual([{ start: 1, end: 2, text: "OK" }]);
  });
});

describe("cueAt", () => {
  const cues = parseSubtitles(SRT);

  it("finds the cue active at a given time", () => {
    expect(cueAt(cues, 2)?.text).toBe("Hello there.");
    expect(cueAt(cues, 6)?.text).toBe("General Kenobi.");
  });

  it("returns null in gaps and outside the range", () => {
    expect(cueAt(cues, 4)).toBeNull();
    expect(cueAt(cues, 0)).toBeNull();
    expect(cueAt(cues, 100)).toBeNull();
  });

  it("treats cue boundaries as inclusive", () => {
    expect(cueAt(cues, 1)?.text).toBe("Hello there.");
    expect(cueAt(cues, 3.5)?.text).toBe("Hello there.");
  });
});

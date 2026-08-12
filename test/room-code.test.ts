import { describe, expect, it } from "vitest";
import { isValidRoomCode, normalizeRoomCode, randomRoomCode } from "../public/shared/room-code.js";

describe("room-code", () => {
  it("accepts 4-24 char uppercase alphanumeric codes", () => {
    expect(isValidRoomCode("MOVIE123")).toBe(true);
    expect(isValidRoomCode("ABCD")).toBe(true);
  });

  it("rejects codes that are too short, too long, or lowercase", () => {
    expect(isValidRoomCode("AB")).toBe(false);
    expect(isValidRoomCode("A".repeat(25))).toBe(false);
    expect(isValidRoomCode("movie123")).toBe(false);
    expect(isValidRoomCode("has space")).toBe(false);
    expect(isValidRoomCode(null)).toBe(false);
    expect(isValidRoomCode(undefined)).toBe(false);
  });

  it("normalizes to trimmed uppercase", () => {
    expect(normalizeRoomCode("  movie123  ")).toBe("MOVIE123");
    expect(normalizeRoomCode(null)).toBe("");
  });

  it("generates codes that pass its own validation", () => {
    for (let i = 0; i < 50; i++) {
      const code = randomRoomCode();
      expect(isValidRoomCode(code)).toBe(true);
    }
  });

  it("excludes visually ambiguous characters (0/O/1/I)", () => {
    const codes = Array.from({ length: 200 }, () => randomRoomCode());
    const chars = new Set(codes.join(""));
    for (const bad of ["0", "O", "1", "I"]) {
      expect(chars.has(bad)).toBe(false);
    }
  });
});

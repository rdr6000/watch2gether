// Shared between the Worker (imported directly) and the browser (served as a
// static asset and loaded as an ES module). One file, one set of rules.

const ROOM_CODE_PATTERN = /^[A-Z0-9]{4,24}$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export function isValidRoomCode(code) {
  return typeof code === "string" && ROOM_CODE_PATTERN.test(code);
}

export function normalizeRoomCode(input) {
  return String(input || "").trim().toUpperCase();
}

export function randomRoomCode(length = 8) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

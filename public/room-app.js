import { isValidRoomCode, normalizeRoomCode, randomRoomCode } from "./shared/room-code.js";
import { SignalingClient } from "./signaling-client.js";
import { WebRtcMesh } from "./webrtc-mesh.js";
import { SubtitleController } from "./subtitle-controller.js";
import { HostPositionClock } from "./position-clock.js";
import { ChatPanel } from "./chat-panel.js";
import { VoiceMesh } from "./voice-mesh.js";
import { VoicePanel } from "./voice-panel.js";
import { ModerationPanel } from "./moderation-panel.js";
import { TabBar } from "./tab-bar.js";
import { WakeLockController } from "./wake-lock.js";
import { SyncCorrector } from "./sync-corrector.js";

const el = (id) => document.getElementById(id);
const lobby = el("lobby");
const nameInput = el("nameInput");
const roomInput = el("roomInput");
const joinBtn = el("joinBtn");

const roomShell = el("roomShell");
const roomCodePill = el("roomCodePill");
const statusDot = el("statusDot");
const statusText = el("statusText");
const roleTag = el("roleTag");
const peopleCountTopNum = el("peopleCountTopNum");
const copyLinkBtn = el("copyLinkBtn");
const leaveBtn = el("leaveBtn");

const hostControls = el("hostControls");
const filePicker = el("filePicker");
const fileInfo = el("fileInfo");
const remoteVideo = el("remoteVideo");
const enablePlayBtn = el("enablePlayBtn");
const hostVideo = el("hostVideo");
const hostOverlay = el("hostOverlay");
const viewerControls = el("viewerControls");
const requestPlayBtn = el("requestPlayBtn");
const requestPauseBtn = el("requestPauseBtn");
const subtitleControls = el("subtitleControls");
const subtitlePicker = el("subtitlePicker");
const subtitleInfo = el("subtitleInfo");
const statusEl = el("status");

const chatForm = el("chatForm");
const chatInput = el("chatInput");
const chatSendBtn = el("chatSendBtn");
const chatDisabledNotice = el("chatDisabledNotice");

const sessionEndedOverlay = el("sessionEndedOverlay");
const sessionEndedTitle = el("sessionEndedTitle");
const sessionEndedMessage = el("sessionEndedMessage");
const backToLobbyBtn = el("backToLobbyBtn");

const tabBar = new TabBar([
  { button: el("tabChatBtn"), panel: el("chatPanelTab") },
  { button: el("tabPeopleBtn"), panel: el("peoplePanelTab") },
  { button: el("tabRoomBtn"), panel: el("roomPanelTab") }
]);

const positionClock = new HostPositionClock();
const hostSubtitles = new SubtitleController(hostOverlay, () => hostVideo.currentTime);
const viewerSubtitles = new SubtitleController(el("watchOverlay"), () => positionClock.estimate());
hostSubtitles.start();
viewerSubtitles.start();

const chatPanel = new ChatPanel({ logEl: el("chatLog"), formEl: chatForm, inputEl: chatInput }, (body) =>
  signaling?.send({ type: "chat", body })
);

const wakeLock = new WakeLockController();
const syncCorrector = new SyncCorrector(remoteVideo);
const syncBadge = el("syncBadge");

let isHost = false;
let myClientId = null;
let allowGuestControl = false;
let currentRoom = null;
let sourceReady = false;
const connectedViewerIds = new Set();

let signaling = null;
let mesh = null;
let voiceMesh = null;
let moderationPanel = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function setConnectionIndicator(state) {
  statusDot.className = "status-dot" + (state === "live" ? " live" : state === "warn" ? " warn" : "");
  statusText.textContent = state === "live" ? "Connected" : state === "warn" ? "Reconnecting" : "Idle";
}

function updateRoleUi() {
  roleTag.hidden = !isHost;
  hostControls.hidden = !isHost;
  viewerControls.hidden = isHost;
  subtitleControls.hidden = false;
  requestPlayBtn.disabled = !allowGuestControl;
  requestPauseBtn.disabled = !allowGuestControl;
  // Left hidden here even for viewers: updateSyncBadge() reveals it once there's
  // an actual drift reading, rather than showing an empty badge before then.
  if (isHost) syncBadge.hidden = true;
}

/** Surfaces whether the drift corrector is actively nudging playback — mostly a transparency signal, not a control. */
function updateSyncBadge(hostPosition) {
  const drift = syncCorrector.currentDriftSeconds(hostPosition);
  if (drift === null) {
    syncBadge.hidden = true;
    return;
  }
  syncBadge.hidden = false;
  const adjusting = Math.abs(drift) > 0.15;
  syncBadge.classList.toggle("adjusting", adjusting);
  syncBadge.textContent = adjusting ? `sync ${drift > 0 ? "+" : ""}${drift.toFixed(1)}s` : "synced";
}

function applyChatEnabled(enabled) {
  chatInput.disabled = !enabled;
  chatSendBtn.disabled = !enabled;
  chatDisabledNotice.hidden = enabled;
}

function wsUrl(room) {
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  return `${proto}${location.host}/ws?room=${encodeURIComponent(room)}`;
}

function myName() {
  return nameInput.value.trim().slice(0, 40);
}

function join(rawCode) {
  const code = isValidRoomCode(normalizeRoomCode(rawCode)) ? normalizeRoomCode(rawCode) : randomRoomCode();
  currentRoom = code;
  roomInput.value = code;
  history.replaceState(null, "", `?room=${encodeURIComponent(code)}`);

  const name = myName();
  if (name) localStorage.setItem("w2g-name", name);

  lobby.hidden = true;
  roomShell.hidden = false;
  sessionEndedOverlay.hidden = true;
  roomCodePill.textContent = code;
  setConnectionIndicator("idle");
  setStatus("Connecting…");

  signaling = new SignalingClient(wsUrl(code));
  mesh = new WebRtcMesh(signaling);
  moderationPanel = new ModerationPanel(
    {
      peopleList: el("peopleList"),
      peopleCount: peopleCountTopNum,
      roomTabBtn: el("tabRoomBtn"),
      lockToggle: el("lockToggle"),
      maxPeersSelect: el("maxPeersSelect"),
      chatToggle: el("chatToggle"),
      voiceToggle: el("voiceToggle"),
      guestControlToggle: el("guestControlToggle")
    },
    signaling
  );
  wireSignaling();
  wireMesh();
  signaling.connect({ room: code, name: name || undefined });
}

function endSession(title, message) {
  signaling?.close();
  mesh?.closeAll();
  voiceMesh?.closeAll();
  wakeLock.disable();
  sessionEndedTitle.textContent = title;
  sessionEndedMessage.textContent = message;
  sessionEndedOverlay.hidden = false;
}

function wireSignaling() {
  signaling.addEventListener("state", (e) => {
    const s = e.detail;
    isHost = s.host;
    myClientId = s.clientId;
    allowGuestControl = s.allowGuestControl;
    updateRoleUi();
    setConnectionIndicator("live");
    setStatus(isHost ? "Pick a video file to start streaming." : "Waiting for the host to start streaming.");

    moderationPanel.setIdentity(myClientId, isHost);
    moderationPanel.renderPeers(s.peers);
    moderationPanel.applySettings(s);
    moderationPanel.applyGuestControl(allowGuestControl);
    applyChatEnabled(s.chatEnabled);

    wakeLock.enable();

    if (!voiceMesh) {
      voiceMesh = new VoiceMesh(signaling, myClientId);
      new VoicePanel(voiceMesh, el("micBtn"));
    }
    voiceMesh.syncPeers(s.peers.map((p) => p.clientId));
  });

  signaling.addEventListener("presence", (e) => {
    moderationPanel.renderPeers(e.detail.peers);
    voiceMesh?.syncPeers(e.detail.peers.map((p) => p.clientId));
    if (!isHost || !mesh) return;
    const liveIds = new Set(e.detail.peers.filter((p) => p.clientId !== myClientId).map((p) => p.clientId));
    for (const id of connectedViewerIds) {
      if (!liveIds.has(id)) {
        mesh.closeConnection(id);
        connectedViewerIds.delete(id);
      }
    }
    if (sourceReady) {
      for (const id of liveIds) {
        if (!connectedViewerIds.has(id)) {
          connectedViewerIds.add(id);
          mesh.connectToViewer(id);
        }
      }
    }
  });

  signaling.addEventListener("hostChanged", (e) => {
    isHost = e.detail.hostClientId === myClientId;
    updateRoleUi();
    moderationPanel.setIdentity(myClientId, isHost);
    mesh?.closeAll();
    connectedViewerIds.clear();
    sourceReady = false;
    setStatus(isHost ? "The previous host left — you're the host now. Pick a video file to start streaming." : "The host changed.");
  });

  signaling.addEventListener("controlAccess", (e) => {
    allowGuestControl = e.detail.allow;
    updateRoleUi();
    moderationPanel.applyGuestControl(allowGuestControl);
  });

  signaling.addEventListener("roomSettings", (e) => {
    moderationPanel.applySettings(e.detail);
    applyChatEnabled(e.detail.chatEnabled);
  });

  signaling.addEventListener("sourceReady", (e) => {
    setStatus(e.detail.ready ? "Streaming." : "No video yet.");
  });

  signaling.addEventListener("controlRequest", (e) => {
    if (!isHost) return;
    if (e.detail.action === "play") hostVideo.play().catch(() => {});
    if (e.detail.action === "pause") hostVideo.pause();
  });

  signaling.addEventListener("positionSync", (e) => {
    positionClock.update(e.detail);
    if (isHost) return;
    syncCorrector.onHostPosition(e.detail.position, e.detail.playing);
    updateSyncBadge(e.detail.position);
  });

  signaling.addEventListener("chatHistory", (e) => chatPanel.setHistory(e.detail.messages));
  signaling.addEventListener("chat", (e) => chatPanel.addMessage(e.detail));

  signaling.addEventListener("kicked", (e) => endSession("Removed from room", e.detail.reason));
  signaling.addEventListener("banned", (e) => endSession("Banned", e.detail.reason));
  signaling.addEventListener("roomExpired", (e) => endSession("Room closed", e.detail.reason));

  signaling.addEventListener("disconnected", () => setConnectionIndicator("warn"));
  signaling.addEventListener("error", (e) => setStatus(e.detail?.message || "Server error."));
}

function wireMesh() {
  mesh.addEventListener("remoteStream", (e) => {
    remoteVideo.srcObject = e.detail.stream;
    syncCorrector.reset(); // a fresh stream has no relationship to any previously-measured latency baseline
    remoteVideo.play().catch(() => {
      enablePlayBtn.hidden = false;
    });
  });
}

filePicker.addEventListener("change", () => {
  const file = filePicker.files?.[0];
  if (!file) return;
  fileInfo.textContent = `${file.name} • ${(file.size / 1024 / 1024 / 1024).toFixed(2)} GB`;
  hostOverlay.hidden = false;
  hostVideo.src = URL.createObjectURL(file);
  hostVideo.load();
  hostVideo.addEventListener(
    "loadedmetadata",
    () => {
      const stream = hostVideo.captureStream ? hostVideo.captureStream() : hostVideo.mozCaptureStream();
      sourceReady = true;
      mesh.setLocalStream(stream);
      signaling.send({ type: "sourceReady", ready: true });
      hostVideo.play().catch(() => {});
    },
    { once: true }
  );
});

// Informational position broadcast for viewers' subtitle timing — see types.ts on positionSync.
let lastPositionBroadcastAt = 0;
function broadcastPosition(force) {
  if (!isHost || !signaling) return;
  const now = Date.now();
  if (!force && now - lastPositionBroadcastAt < 1000) return;
  lastPositionBroadcastAt = now;
  signaling.send({ type: "positionUpdate", position: hostVideo.currentTime, playing: !hostVideo.paused });
}
hostVideo.addEventListener("timeupdate", () => broadcastPosition(false));
hostVideo.addEventListener("play", () => broadcastPosition(true));
hostVideo.addEventListener("pause", () => broadcastPosition(true));
hostVideo.addEventListener("seeked", () => broadcastPosition(true));

subtitlePicker.addEventListener("change", async () => {
  const file = subtitlePicker.files?.[0];
  if (!file) return;
  const controller = isHost ? hostSubtitles : viewerSubtitles;
  await controller.loadFile(file);
  subtitleInfo.textContent = file.name;
});

copyLinkBtn.addEventListener("click", async () => {
  const url = `${location.origin}/?room=${encodeURIComponent(currentRoom)}`;
  await navigator.clipboard.writeText(url);
  setStatus("Invite link copied.");
});

requestPlayBtn.addEventListener("click", () => signaling.send({ type: "controlRequest", action: "play" }));
requestPauseBtn.addEventListener("click", () => signaling.send({ type: "controlRequest", action: "pause" }));

enablePlayBtn.addEventListener("click", () => {
  remoteVideo.play().then(() => (enablePlayBtn.hidden = true));
});

leaveBtn.addEventListener("click", () => endSession("You left the room", "You can rejoin any time with the same room code."));

backToLobbyBtn.addEventListener("click", () => {
  sessionEndedOverlay.hidden = true;
  roomShell.hidden = true;
  lobby.hidden = false;
  history.replaceState(null, "", location.pathname);
});

joinBtn.addEventListener("click", () => join(roomInput.value));
roomInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") join(roomInput.value);
});
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") join(roomInput.value);
});

const savedName = localStorage.getItem("w2g-name");
if (savedName) nameInput.value = savedName;

// A room in the URL only auto-joins if we already know this browser's name
// (a returning visitor) — a first-time visitor gets the room code prefilled
// but still has to type their name and confirm, so everyone in the room
// actually has a name instead of a generic "Viewer" (caught in testing:
// auto-joining unconditionally skipped the name prompt entirely).
const invited = new URLSearchParams(location.search).get("room");
if (invited) {
  roomInput.value = invited;
  if (savedName) join(invited);
  else nameInput.focus();
}

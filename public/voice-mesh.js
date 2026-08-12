// Full mesh, audio-only: every peer opens a direct connection to every other
// peer (unlike webrtc-mesh.js, which is host -> viewer only). To avoid two
// peers both offering to each other at once (glare), the peer with the
// lexicographically smaller clientId always initiates.
//
// Each connection gets a sendrecv audio transceiver up front, with no track
// attached, so the one negotiation at connect time already covers both
// directions. Muting/unmuting afterward is just transceiver.sender
// .replaceTrack(...) — no renegotiation, no further signaling needed.

const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.cloudflare.com:3478" }];

export class VoiceMesh extends EventTarget {
  #signaling;
  #myClientId;
  #iceServers;
  #micTrack = null;
  #connections = new Map();

  constructor(signaling, myClientId, iceServers = DEFAULT_ICE_SERVERS) {
    super();
    this.#signaling = signaling;
    this.#myClientId = myClientId;
    this.#iceServers = iceServers;

    signaling.addEventListener("rtcOffer", (e) => e.detail.purpose === "voice" && this.#handleOffer(e.detail.fromId, e.detail.sdp));
    signaling.addEventListener("rtcAnswer", (e) => e.detail.purpose === "voice" && this.#handleAnswer(e.detail.fromId, e.detail.sdp));
    signaling.addEventListener(
      "rtcIceCandidate",
      (e) => e.detail.purpose === "voice" && this.#handleIceCandidate(e.detail.fromId, e.detail.candidate)
    );
  }

  /** Call whenever the room's peer list changes: connects to newly-seen peers, drops ones who left. */
  syncPeers(peerIds) {
    for (const id of peerIds) {
      if (id === this.#myClientId || this.#connections.has(id)) continue;
      if (this.#myClientId < id) this.#connectTo(id);
      // else: the lower-id side initiates; we wait for their offer
    }
    for (const id of [...this.#connections.keys()]) {
      if (!peerIds.includes(id)) this.#close(id);
    }
  }

  /** Pass a MediaStreamTrack to unmute, or null to mute — applies to every open connection instantly. */
  setMicTrack(track) {
    this.#micTrack = track;
    for (const { transceiver } of this.#connections.values()) transceiver.sender.replaceTrack(track);
  }

  closeAll() {
    for (const id of [...this.#connections.keys()]) this.#close(id);
  }

  async #connectTo(clientId) {
    const entry = this.#createConnection(clientId);
    const offer = await entry.pc.createOffer();
    await entry.pc.setLocalDescription(offer);
    this.#signaling.send({ type: "rtcOffer", targetId: clientId, sdp: offer, purpose: "voice" });
  }

  async #handleOffer(fromId, sdp) {
    const entry = this.#connections.get(fromId) ?? this.#createConnection(fromId);
    await entry.pc.setRemoteDescription(sdp);
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    this.#signaling.send({ type: "rtcAnswer", targetId: fromId, sdp: answer, purpose: "voice" });
  }

  async #handleAnswer(fromId, sdp) {
    const entry = this.#connections.get(fromId);
    if (!entry || entry.pc.signalingState !== "have-local-offer") return; // stale/duplicate answer — nothing to apply it to
    try {
      await entry.pc.setRemoteDescription(sdp);
    } catch {
      // benign race: connection moved on between the check above and this call
    }
  }

  async #handleIceCandidate(fromId, candidate) {
    try {
      await this.#connections.get(fromId)?.pc.addIceCandidate(candidate);
    } catch {
      // benign if the connection already closed or the candidate arrived late
    }
  }

  #createConnection(clientId) {
    const pc = new RTCPeerConnection({ iceServers: this.#iceServers });
    const transceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
    if (this.#micTrack) transceiver.sender.replaceTrack(this.#micTrack);

    pc.addEventListener("icecandidate", (e) => {
      if (e.candidate) this.#signaling.send({ type: "rtcIceCandidate", targetId: clientId, candidate: e.candidate, purpose: "voice" });
    });
    pc.addEventListener("track", (e) => {
      this.dispatchEvent(new CustomEvent("remoteAudio", { detail: { clientId, stream: e.streams[0] } }));
    });

    const entry = { pc, transceiver };
    this.#connections.set(clientId, entry);
    return entry;
  }

  #close(clientId) {
    this.#connections.get(clientId)?.pc.close();
    this.#connections.delete(clientId);
    this.dispatchEvent(new CustomEvent("peerLeft", { detail: { clientId } }));
  }
}

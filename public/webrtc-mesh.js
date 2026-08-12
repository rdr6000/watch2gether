// Manages one RTCPeerConnection per remote peer. The host opens a connection
// toward each viewer and pushes its captured local stream down it; a viewer
// only ever receives one connection, from the host. Both roles reuse this
// same class — which side initiates is the only difference (see
// connectToViewer vs the automatic response to an incoming "rtcOffer").

const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.cloudflare.com:3478" }];

export class WebRtcMesh extends EventTarget {
  #signaling;
  #iceServers;
  #localStream = null;
  #connections = new Map();

  constructor(signaling, iceServers = DEFAULT_ICE_SERVERS) {
    super();
    this.#signaling = signaling;
    this.#iceServers = iceServers;

    signaling.addEventListener("rtcOffer", (e) => e.detail.purpose === "video" && this.#handleOffer(e.detail.fromId, e.detail.sdp));
    signaling.addEventListener("rtcAnswer", (e) => e.detail.purpose === "video" && this.#handleAnswer(e.detail.fromId, e.detail.sdp));
    signaling.addEventListener(
      "rtcIceCandidate",
      (e) => e.detail.purpose === "video" && this.#handleIceCandidate(e.detail.fromId, e.detail.candidate)
    );
  }

  /** Host only: the stream to send down every peer connection (existing and future). */
  setLocalStream(stream) {
    this.#localStream = stream;
    for (const pc of this.#connections.values()) this.#applyLocalStream(pc);
  }

  /** Host only: open a connection toward a newly-joined viewer and send it an offer. */
  async connectToViewer(clientId) {
    const pc = this.#getOrCreateConnection(clientId);
    this.#applyLocalStream(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.#signaling.send({ type: "rtcOffer", targetId: clientId, sdp: offer, purpose: "video" });
  }

  closeConnection(clientId) {
    this.#connections.get(clientId)?.close();
    this.#connections.delete(clientId);
  }

  closeAll() {
    for (const clientId of [...this.#connections.keys()]) this.closeConnection(clientId);
  }

  async #handleOffer(fromId, sdp) {
    const pc = this.#getOrCreateConnection(fromId);
    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.#signaling.send({ type: "rtcAnswer", targetId: fromId, sdp: answer, purpose: "video" });
  }

  async #handleAnswer(fromId, sdp) {
    const pc = this.#connections.get(fromId);
    if (!pc || pc.signalingState !== "have-local-offer") return; // stale/duplicate answer — nothing to apply it to
    try {
      await pc.setRemoteDescription(sdp);
    } catch {
      // benign race: connection moved on (renegotiated/closed) between the check above and this call
    }
  }

  async #handleIceCandidate(fromId, candidate) {
    try {
      await this.#connections.get(fromId)?.addIceCandidate(candidate);
    } catch {
      // benign if the connection already closed or the candidate arrived late
    }
  }

  #applyLocalStream(pc) {
    if (!this.#localStream) return;
    const senders = pc.getSenders();
    for (const track of this.#localStream.getTracks()) {
      const existing = senders.find((s) => s.track && s.track.kind === track.kind);
      if (existing) existing.replaceTrack(track);
      else pc.addTrack(track, this.#localStream);
    }
  }

  #getOrCreateConnection(clientId) {
    let pc = this.#connections.get(clientId);
    if (pc) return pc;

    pc = new RTCPeerConnection({ iceServers: this.#iceServers });
    pc.addEventListener("icecandidate", (e) => {
      if (e.candidate) this.#signaling.send({ type: "rtcIceCandidate", targetId: clientId, candidate: e.candidate, purpose: "video" });
    });
    pc.addEventListener("track", (e) => {
      this.dispatchEvent(new CustomEvent("remoteStream", { detail: { clientId, stream: e.streams[0] } }));
    });
    pc.addEventListener("connectionstatechange", () => {
      this.dispatchEvent(new CustomEvent("connectionStateChange", { detail: { clientId, state: pc.connectionState } }));
    });

    this.#connections.set(clientId, pc);
    return pc;
  }
}

/** Wires a mic toggle button to VoiceMesh and plays remote peers' voice through hidden <audio> elements. */
export class VoicePanel {
  #voiceMesh;
  #micBtn;
  #micTrack = null;
  #audioEls = new Map();

  constructor(voiceMesh, micBtn) {
    this.#voiceMesh = voiceMesh;
    this.#micBtn = micBtn;
    micBtn.addEventListener("click", () => this.#toggleMic());

    voiceMesh.addEventListener("remoteAudio", (e) => this.#attachRemoteAudio(e.detail.clientId, e.detail.stream));
    voiceMesh.addEventListener("peerLeft", (e) => this.#detachRemoteAudio(e.detail.clientId));
  }

  async #toggleMic() {
    if (this.#micTrack) {
      this.#micTrack.stop();
      this.#micTrack = null;
      this.#voiceMesh.setMicTrack(null);
      this.#micBtn.textContent = "🎤 Enable mic";
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.#micTrack = stream.getAudioTracks()[0];
      this.#voiceMesh.setMicTrack(this.#micTrack);
      this.#micBtn.textContent = "🔴 Mute mic";
    } catch {
      this.#micBtn.textContent = "Mic unavailable";
    }
  }

  #attachRemoteAudio(clientId, stream) {
    let audioEl = this.#audioEls.get(clientId);
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      document.body.appendChild(audioEl);
      this.#audioEls.set(clientId, audioEl);
    }
    audioEl.srcObject = stream;
  }

  #detachRemoteAudio(clientId) {
    this.#audioEls.get(clientId)?.remove();
    this.#audioEls.delete(clientId);
  }
}

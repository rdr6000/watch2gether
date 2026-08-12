// Thin wrapper around the room WebSocket: typed send(), on(type, cb) event
// emitter, and reconnect-with-backoff. Nothing here knows about WebRTC or
// the DOM — see webrtc-mesh.js and room-app.js for those.

export class SignalingClient extends EventTarget {
  #url;
  #ws = null;
  #joined = false;
  #reconnectAttempt = 0;
  #reconnectTimer = null;
  #closedByUser = false;

  constructor(url) {
    super();
    this.#url = url;
  }

  connect(joinPayload) {
    this.#closedByUser = false;
    this.#joined = false;
    clearTimeout(this.#reconnectTimer);

    const ws = new WebSocket(this.#url);
    this.#ws = ws;

    ws.addEventListener("open", () => {
      this.#reconnectAttempt = 0;
      ws.send(JSON.stringify({ type: "join", ...joinPayload }));
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "state") this.#joined = true;
      if (msg.type === "ping") {
        this.send({ type: "pong" });
        return;
      }
      this.dispatchEvent(new CustomEvent("message", { detail: msg }));
      this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
    });

    ws.addEventListener("close", () => {
      this.dispatchEvent(new CustomEvent("disconnected", { detail: { joined: this.#joined } }));
      if (this.#closedByUser) return;
      const delay = Math.min(1000 * 2 ** this.#reconnectAttempt, 8000);
      this.#reconnectAttempt++;
      this.#reconnectTimer = setTimeout(() => this.connect(joinPayload), delay);
    });

    ws.addEventListener("error", () => {
      this.dispatchEvent(new CustomEvent("connectionError"));
    });
  }

  send(message) {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(message));
    }
  }

  close() {
    this.#closedByUser = true;
    clearTimeout(this.#reconnectTimer);
    this.#ws?.close();
  }
}

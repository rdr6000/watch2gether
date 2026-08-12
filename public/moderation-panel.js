// Renders the People list (with host-only kick/ban) and the Room settings
// tab (lock, capacity, chat/voice availability, guest playback control).
// Pure DOM glue wired to a set of elements handed in from room-app.js.
export class ModerationPanel {
  #els;
  #signaling;
  #isHost = false;
  #myClientId = null;

  constructor(els, signaling) {
    this.#els = els;
    this.#signaling = signaling;

    els.lockToggle.addEventListener("change", () => this.#send({ locked: els.lockToggle.checked }));
    els.chatToggle.addEventListener("change", () => this.#send({ chatEnabled: els.chatToggle.checked }));
    els.voiceToggle.addEventListener("change", () => this.#send({ voiceEnabled: els.voiceToggle.checked }));
    els.guestControlToggle.addEventListener("change", () => {
      signaling.send({ type: "controlAccess", allow: els.guestControlToggle.checked });
    });
    els.maxPeersSelect.addEventListener("change", () => {
      const value = els.maxPeersSelect.value;
      this.#send({ maxPeers: value === "" ? null : Number(value) });
    });
  }

  #send(patch) {
    this.#signaling.send({ type: "roomSettings", ...patch });
  }

  setIdentity(myClientId, isHost) {
    this.#myClientId = myClientId;
    this.#isHost = isHost;
    // Only toggle whether the Room tab is available at all — which panel is
    // *currently visible* is TabBar's job, and fighting it here is what
    // caused Chat and Room to render at once (caught in browser testing).
    this.#els.roomTabBtn.hidden = !isHost;
  }

  renderPeers(peers) {
    this.#els.peopleList.replaceChildren(...peers.map((p) => this.#renderRow(p)));
    this.#els.peopleCount.textContent = String(peers.length);
  }

  applySettings(settings) {
    this.#els.lockToggle.checked = settings.locked;
    this.#els.chatToggle.checked = settings.chatEnabled;
    this.#els.voiceToggle.checked = settings.voiceEnabled;
    this.#els.maxPeersSelect.value = settings.maxPeers === null ? "" : String(settings.maxPeers);
  }

  applyGuestControl(allow) {
    this.#els.guestControlToggle.checked = allow;
  }

  #renderRow(peer) {
    const li = document.createElement("li");
    li.className = "person-row";

    const name = document.createElement("span");
    name.className = "person-name";
    name.textContent = peer.name;
    li.appendChild(name);

    if (peer.role === "host") {
      const tag = document.createElement("span");
      tag.className = "person-tag";
      tag.textContent = "Host";
      li.appendChild(tag);
    }

    if (this.#isHost && peer.clientId !== this.#myClientId) {
      const actions = document.createElement("span");
      actions.className = "person-actions";

      const kickBtn = document.createElement("button");
      kickBtn.type = "button";
      kickBtn.className = "ghost tiny";
      kickBtn.textContent = "Kick";
      kickBtn.addEventListener("click", () => this.#signaling.send({ type: "kickPeer", clientId: peer.clientId }));

      const banBtn = document.createElement("button");
      banBtn.type = "button";
      banBtn.className = "ghost tiny danger";
      banBtn.textContent = "Ban";
      banBtn.addEventListener("click", () => {
        if (confirm(`Ban ${peer.name}? They won't be able to rejoin this room.`)) {
          this.#signaling.send({ type: "banPeer", clientId: peer.clientId });
        }
      });

      actions.append(kickBtn, banBtn);
      li.appendChild(actions);
    }

    return li;
  }
}

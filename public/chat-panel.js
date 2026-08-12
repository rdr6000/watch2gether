/** Renders chat messages into a list and wires the send form. Pure DOM glue — no networking here. */
export class ChatPanel {
  #logEl;
  #onSend;

  constructor({ logEl, formEl, inputEl }, onSend) {
    this.#logEl = logEl;
    this.#onSend = onSend;

    formEl.addEventListener("submit", (e) => {
      e.preventDefault();
      const body = inputEl.value.trim();
      if (!body) return;
      this.#onSend(body);
      inputEl.value = "";
    });
  }

  setHistory(messages) {
    this.#logEl.replaceChildren();
    for (const message of messages) this.#appendRow(message);
  }

  addMessage(message) {
    this.#appendRow(message);
  }

  #appendRow({ senderName, body }) {
    const li = document.createElement("li");
    const sender = document.createElement("span");
    sender.className = "sender";
    sender.textContent = `${senderName}:`;
    li.append(sender, document.createTextNode(body));
    this.#logEl.appendChild(li);
    this.#logEl.scrollTop = this.#logEl.scrollHeight;
  }
}

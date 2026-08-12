// Keeps the screen from sleeping while a room is open. Wake locks are
// automatically released by the browser when the tab is hidden, so this
// re-acquires on visibility regain rather than trying to fight that.
export class WakeLockController {
  #sentinel = null;
  #enabled = false;

  async enable() {
    this.#enabled = true;
    if (!("wakeLock" in navigator)) return;
    document.addEventListener("visibilitychange", this.#onVisibilityChange);
    await this.#acquire();
  }

  disable() {
    this.#enabled = false;
    document.removeEventListener("visibilitychange", this.#onVisibilityChange);
    this.#sentinel?.release();
    this.#sentinel = null;
  }

  async #acquire() {
    try {
      this.#sentinel = await navigator.wakeLock.request("screen");
    } catch {
      // denied, unsupported in this context, or no longer visible — silently skip
    }
  }

  #onVisibilityChange = async () => {
    if (this.#enabled && document.visibilityState === "visible") await this.#acquire();
  };
}

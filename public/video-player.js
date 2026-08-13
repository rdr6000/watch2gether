// A custom control bar replacing the browser's native <video controls>, in
// two modes:
//  - "interactive" (host): play/pause/seek act directly on the video — it's
//    a real local file, fully seekable.
//  - "remote" (viewer): the video is a *live* WebRTC relay, not seekable in
//    the normal sense (see webrtc-mesh.js). Play/pause/seek become requests
//    routed through the existing controlRequest protocol; progress is drawn
//    from the host's broadcast position (getRemoteProgress), not the local
//    video element's own clock.
// Volume, mute, speed (interactive only), fullscreen, and PiP always act on
// this viewer's own playback locally, regardless of mode.

const ICONS = {
  play: '<path d="M6 4l14 8-14 8V4z"/>',
  pause: '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>',
  volume: '<path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M16 8a5 5 0 010 8" fill="none" stroke="currentColor" stroke-width="2"/>',
  muted: '<path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2"/>',
  pip: '<rect x="3" y="4" width="18" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor"/>'
};

function svg(name, size = 18) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor">${ICONS[name]}</svg>`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
}

export class VideoPlayer {
  #video;
  #root;
  #mode;
  #onRequestPlay;
  #onRequestPause;
  #onRequestSeek;
  #getRemoteProgress;
  #canControl;
  #remoteTimer = null;
  #hideTimer = null;
  #scrubbing = false;

  constructor(video, container, options = {}) {
    this.#video = video;
    this.#mode = options.mode === "remote" ? "remote" : "interactive";
    this.#onRequestPlay = options.onRequestPlay ?? (() => {});
    this.#onRequestPause = options.onRequestPause ?? (() => {});
    this.#onRequestSeek = options.onRequestSeek ?? (() => {});
    this.#getRemoteProgress = options.getRemoteProgress ?? (() => null);
    this.#canControl = options.canControl ?? true;

    this.#root = document.createElement("div");
    this.#root.className = "player";
    video.parentNode.insertBefore(this.#root, video);
    this.#root.appendChild(video);
    video.removeAttribute("controls");

    this.#buildControls();
    this.#wireEvents();
    if (this.#mode === "remote") this.#remoteTimer = setInterval(() => this.#tickRemote(), 200);
  }

  /** Viewer only: whether play/pause/seek requests are currently allowed (affects affordance, not just behavior). */
  setControlAllowed(allowed) {
    this.#canControl = allowed;
    this.#root.classList.toggle("player-locked", this.#mode === "remote" && !allowed);
  }

  destroy() {
    clearInterval(this.#remoteTimer);
    clearTimeout(this.#hideTimer);
  }

  #buildControls() {
    this.#root.insertAdjacentHTML(
      "beforeend",
      `
      <button type="button" class="player-center-btn" aria-label="Play/pause">${svg("play", 28)}</button>
      <div class="player-controls">
        <div class="player-progress" tabindex="0" role="slider" aria-label="Seek">
          <div class="player-progress-buffered"></div>
          <div class="player-progress-played"></div>
          <div class="player-progress-thumb"></div>
        </div>
        <div class="player-buttons">
          <button type="button" class="player-btn player-play" aria-label="Play/pause">${svg("play")}</button>
          <div class="player-volume">
            <button type="button" class="player-btn player-mute" aria-label="Mute">${svg("volume")}</button>
            <input type="range" class="player-volume-slider" min="0" max="1" step="0.01" value="1" aria-label="Volume">
          </div>
          <span class="player-time mono">0:00 / 0:00</span>
          <span class="player-spacer"></span>
          ${this.#mode === "interactive" ? '<select class="player-speed" aria-label="Playback speed"><option value="0.5">0.5x</option><option value="0.75">0.75x</option><option value="1" selected>1x</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option><option value="2">2x</option></select>' : ""}
          <button type="button" class="player-btn player-pip" aria-label="Picture in picture">${svg("pip")}</button>
          <button type="button" class="player-btn player-fullscreen" aria-label="Fullscreen">${svg("fullscreen")}</button>
        </div>
      </div>
    `
    );
  }

  #q(selector) {
    return this.#root.querySelector(selector);
  }

  #wireEvents() {
    const video = this.#video;
    const centerBtn = this.#q(".player-center-btn");
    const playBtn = this.#q(".player-play");
    const muteBtn = this.#q(".player-mute");
    const volumeSlider = this.#q(".player-volume-slider");
    const progress = this.#q(".player-progress");
    const speedSelect = this.#q(".player-speed");
    const pipBtn = this.#q(".player-pip");
    const fullscreenBtn = this.#q(".player-fullscreen");

    const togglePlay = () => {
      const playing = this.#mode === "interactive" ? !video.paused : this.#getRemoteProgress()?.playing;
      if (this.#mode === "interactive") {
        if (playing) video.pause();
        else video.play().catch(() => {});
        return;
      }
      if (!this.#canControl) return;
      if (playing) this.#onRequestPause();
      else this.#onRequestPlay();
    };

    centerBtn.addEventListener("click", togglePlay);
    playBtn.addEventListener("click", togglePlay);
    video.addEventListener("click", togglePlay);

    if (this.#mode === "interactive") {
      video.addEventListener("play", () => this.#setPlayingIcon(true));
      video.addEventListener("pause", () => this.#setPlayingIcon(false));
      video.addEventListener("timeupdate", () => this.#renderProgress(video.currentTime, video.duration));
      video.addEventListener("durationchange", () => this.#renderProgress(video.currentTime, video.duration));
      video.addEventListener("progress", () => this.#renderBuffered());
    }

    muteBtn.addEventListener("click", () => {
      video.muted = !video.muted;
      this.#renderVolumeIcon();
    });
    volumeSlider.addEventListener("input", () => {
      video.volume = Number(volumeSlider.value);
      video.muted = video.volume === 0;
      this.#renderVolumeIcon();
    });

    const seekFromEvent = (clientX) => {
      const rect = progress.getBoundingClientRect();
      const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const duration = this.#mode === "interactive" ? video.duration : this.#getRemoteProgress()?.duration;
      if (!Number.isFinite(duration)) return;
      const target = fraction * duration;
      if (this.#mode === "interactive") video.currentTime = target;
      else if (this.#canControl) this.#onRequestSeek(target);
    };
    progress.addEventListener("pointerdown", (e) => {
      if (this.#mode === "remote" && !this.#canControl) return;
      this.#scrubbing = true;
      seekFromEvent(e.clientX);
      progress.setPointerCapture(e.pointerId);
    });
    progress.addEventListener("pointermove", (e) => {
      if (this.#scrubbing) seekFromEvent(e.clientX);
    });
    progress.addEventListener("pointerup", () => (this.#scrubbing = false));

    speedSelect?.addEventListener("change", () => (video.playbackRate = Number(speedSelect.value)));

    pipBtn.addEventListener("click", async () => {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await video.requestPictureInPicture();
      } catch {
        // PiP unsupported or blocked — no-op, the button just does nothing
      }
    });

    fullscreenBtn.addEventListener("click", () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else this.#root.requestFullscreen().catch(() => {});
    });

    this.#root.addEventListener("mousemove", () => this.#revealControls());
    this.#root.addEventListener("mouseleave", () => this.#scheduleHide());
    this.#revealControls();
  }

  #setPlayingIcon(playing) {
    const icon = svg(playing ? "pause" : "play");
    this.#q(".player-play").innerHTML = icon;
    this.#q(".player-center-btn").innerHTML = svg(playing ? "pause" : "play", 28);
    this.#root.classList.toggle("player-playing", playing);
    if (playing) this.#scheduleHide();
    else this.#revealControls();
  }

  #renderVolumeIcon() {
    this.#q(".player-mute").innerHTML = svg(this.#video.muted || this.#video.volume === 0 ? "muted" : "volume");
  }

  #renderBuffered() {
    if (this.#mode !== "interactive" || !this.#video.duration) return;
    const buffered = this.#video.buffered;
    const end = buffered.length > 0 ? buffered.end(buffered.length - 1) : 0;
    this.#q(".player-progress-buffered").style.width = `${Math.min(100, (end / this.#video.duration) * 100)}%`;
  }

  #renderProgress(position, duration) {
    const pct = Number.isFinite(duration) && duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
    this.#q(".player-progress-played").style.width = `${pct}%`;
    this.#q(".player-progress-thumb").style.left = `${pct}%`;
    this.#q(".player-time").textContent = `${formatTime(position)} / ${formatTime(duration)}`;
    if (this.#mode === "interactive") this.#renderBuffered();
  }

  #tickRemote() {
    const progress = this.#getRemoteProgress();
    if (!progress) return;
    this.#renderProgress(progress.position, progress.duration);
    this.#setPlayingIcon(Boolean(progress.playing));
  }

  #revealControls() {
    clearTimeout(this.#hideTimer);
    this.#root.classList.remove("player-controls-hidden");
    this.#scheduleHide();
  }

  #scheduleHide() {
    clearTimeout(this.#hideTimer);
    const playing = this.#mode === "interactive" ? !this.#video.paused : this.#getRemoteProgress()?.playing;
    if (!playing) return;
    this.#hideTimer = setTimeout(() => this.#root.classList.add("player-controls-hidden"), 2500);
  }
}

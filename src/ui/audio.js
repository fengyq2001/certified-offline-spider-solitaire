const CUES = Object.freeze({
  move: [[330, 0, 0.045]],
  deal: [[220, 0, 0.045], [260, 0.055, 0.045]],
  undo: [[280, 0, 0.04], [210, 0.05, 0.05]],
  complete: [[440, 0, 0.06], [660, 0.07, 0.09]],
  win: [[392, 0, 0.08], [523, 0.09, 0.08], [659, 0.18, 0.13]],
  select: [[520, 0, 0.035]],
});

function defaultContextFactory() {
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return Context ? new Context() : null;
}

/** Local synthesized feedback. It creates no context until a user action calls play. */
export class LocalSoundFeedback {
  constructor({ contextFactory = defaultContextFactory } = {}) {
    this.contextFactory = contextFactory;
    this.context = null;
    this.enabled = false;
  }

  setPreferences(preferences = {}) {
    this.enabled = preferences.sound === true;
  }

  play(name) {
    if (!this.enabled || !CUES[name]) return false;
    try {
      this.context ??= this.contextFactory();
      if (!this.context) return false;
      if (this.context.state === "suspended") void this.context.resume?.();
      const base = this.context.currentTime;
      for (const [frequency, delay, duration] of CUES[name]) {
        const oscillator = this.context.createOscillator();
        const gain = this.context.createGain();
        const start = base + delay;
        const end = start + duration;
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.065, start + Math.min(0.012, duration / 3));
        gain.gain.exponentialRampToValueAtTime(0.0001, end);
        oscillator.connect(gain);
        gain.connect(this.context.destination);
        oscillator.start(start);
        oscillator.stop(end + 0.01);
      }
      return true;
    } catch {
      return false;
    }
  }
}

export function showVictoryCelebration(root, preferences = {}, {
  setTimer = setTimeout,
  matchMedia = (query) => globalThis.matchMedia?.(query) ?? { matches: false },
} = {}) {
  const documentNode = root?.ownerDocument ?? root;
  if (!documentNode?.createElement) return null;
  const motionAllowed = preferences.animation !== false
    && preferences.reduceMotion !== true
    && !(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  if (!motionAllowed) return null;
  documentNode.querySelector?.(".victory-celebration")?.remove();
  const overlay = documentNode.createElement("div");
  overlay.className = "victory-celebration";
  overlay.setAttribute("aria-hidden", "true");
  overlay.innerHTML = Array.from({ length: 28 }, (_, index) => (
    `<i style="--i:${index};--x:${(index * 37) % 100}%;--drift:${(index - 14) * 12}px;--delay:${(index % 7) * 45}ms"></i>`
  )).join("");
  (documentNode.body ?? root).append(overlay);
  setTimer(() => overlay.remove(), 2400);
  return overlay;
}

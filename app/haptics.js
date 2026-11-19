// Web Audio + Vibration haptic feedback for iOS Safari and Android. Zero dependencies.
// Lazily created audio context; browsers only allow audio after a user gesture.
let ctx = null;

// Return the shared AudioContext, or null where unsupported (including non-browser test runs).
function getAudio() {
  if (ctx) return ctx;
  const AudioCtx = typeof window !== "undefined" ? (window.AudioContext || window.webkitAudioContext) : null;
  if (!AudioCtx) return null;
  try {
    ctx = new AudioCtx();
  } catch {
    ctx = null;
  }
  return ctx;
}

// Unlock audio context on user gesture
export function initHaptics() {
  const c = getAudio();
  if (c && c.state === "suspended") {
    c.resume().catch(() => {});
  }
}

// Vibrate if supported (Android; iOS Safari ignores it). Errors are ignored: haptics are optional.
export function vibrate(pattern = 15) {
  if (typeof navigator !== "undefined" && navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch {}
  }
}

// Crisp subtle pop on allow (rising chirp: 520Hz -> 820Hz, 30ms)
export function hapticAllow() {
  vibrate(15);
  const c = getAudio();
  // Audio is skipped unless already unlocked by a user gesture.
  if (!c || c.state !== "running") return;
  try {
    const osc = c.createOscillator();
    const gain = c.createGain();
    const t = c.currentTime;
    osc.type = "sine";
    osc.frequency.setValueAtTime(520, t);
    osc.frequency.exponentialRampToValueAtTime(820, t + 0.04);
    gain.gain.setValueAtTime(0.08, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.05);
  } catch {}
}

// Low subtle thud on deny (falling thud: 240Hz -> 110Hz, 45ms)
export function hapticDeny() {
  vibrate([20, 40, 20]);
  const c = getAudio();
  if (!c || c.state !== "running") return;
  try {
    const osc = c.createOscillator();
    const gain = c.createGain();
    const t = c.currentTime;
    osc.type = "triangle";
    osc.frequency.setValueAtTime(240, t);
    osc.frequency.exponentialRampToValueAtTime(110, t + 0.05);
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.06);
  } catch {}
}

// Alert chime when a new high/medium ask arrives (two-tone chime: 587Hz -> 880Hz)
export function hapticAlert() {
  vibrate([40, 80, 40]);
  const c = getAudio();
  if (!c || c.state !== "running") return;
  try {
    const t = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, t); // D5
    osc.frequency.setValueAtTime(880, t + 0.08); // A5
    gain.gain.setValueAtTime(0.1, t);
    gain.gain.setValueAtTime(0.12, t + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.24);
  } catch {}
}

// Program: ashr - haptics.js
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Small touch and sound feedback (vibration plus short Web Audio tones) for allow, deny and new-request alerts, with no libraries.
// Web Audio + Vibration haptic feedback for iOS Safari and Android. Zero dependencies.
// The shared audio context; created the first time it is needed.
let ctx = null;

// Create the audio context once. Returns null if the browser has no Web Audio or creating it fails.
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

// Browsers only allow sound after a user gesture, so call this from a tap to resume a suspended context.
// Unlock audio context on user gesture
// Resume the audio context if it was suspended.
export function initHaptics() {
  const c = getAudio();
  if (c && c.state === "suspended") {
    c.resume().catch(() => {});
  }
}

// Vibrate the phone if supported; the try/catch ignores browsers that refuse.
export function vibrate(pattern = 15) {
  if (typeof navigator !== "undefined" && navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch {}
  }
}

// Short rising tone and a short buzz for "allow".
// Crisp subtle pop on allow (rising chirp: 520Hz -> 820Hz, 30ms)
// Play the allow feedback. Each tone is an oscillator going through a gain node that fades the volume to near zero.
export function hapticAllow() {
  vibrate(15);
  const c = getAudio();
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

// Short falling tone and a double buzz for "deny".
// Low subtle thud on deny (falling thud: 240Hz -> 110Hz, 45ms)
// Play the deny feedback, a lower triangle-wave thud.
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

// Two-note chime and a triple buzz for a new request.
// Alert chime when a new high/medium ask arrives (two-tone chime: 587Hz -> 880Hz)
// Play the alert: D5 then A5.
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

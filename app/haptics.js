// Web Audio + Vibration haptic feedback for iOS Safari and Android. Zero dependencies.
// Lazily created audio context; browsers only allow audio after a user gesture.
//
// How it fits: swipe.js calls hapticAllow/hapticDeny when a swipe is released, app.js calls
// hapticAlert when a NEW ask arrives and initHaptics on the first keyboard shortcut. All sounds are
// synthesised with oscillators (no audio files), kept very short and quiet (gain 0.08-0.12) so they
// feel like clicks rather than alarms. Everything is wrapped in try/catch: feedback is optional and
// must never break a decision.
let ctx = null;

// Return the shared AudioContext, or null where unsupported (including non-browser test runs).
/**
 * @returns {AudioContext|null} shared context, created on first use; null when unsupported (Node
 *   tests, old browsers).
 */
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
/**
 * Resumes a suspended AudioContext. Browsers (especially iOS Safari) start it suspended until a user
 * gesture, so this is called from gesture handlers (pointerdown, key press).
 * @returns {void}
 */
export function initHaptics() {
  const c = getAudio();
  if (c && c.state === "suspended") {
    c.resume().catch(() => {});
  }
}

// Vibrate if supported (Android; iOS Safari ignores it). Errors are ignored: haptics are optional.
/**
 * @param {number|number[]} [pattern=15] - ms, or alternating vibrate/pause ms.
 * @returns {void}
 */
export function vibrate(pattern = 15) {
  if (typeof navigator !== "undefined" && navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch {}
  }
}

// Crisp subtle pop on allow (rising chirp: 520Hz -> 820Hz, 30ms)
/** Short rising chirp plus a 15 ms buzz. @returns {void} */
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
/** Short falling thud plus a three-part buzz. @returns {void} */
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
/** Two-note chime (D5 then A5) and a longer buzz for a new request. @returns {void} */
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

// Effects for decisions. Each one stamps a face on the card, then the card leaves.
// Allow = thumbs up, then the card glides away. Deny = thumbs down, a fire slash, then it burns.
// Redirect = a neutral face, then the card lifts away.
//
// How it fits: app.js sendDecision() calls seal(card), burn(card) or shrug(card) after the hub
//   accepted the decision. The animations themselves are CSS (classes .sealing, .burning,
//   .shrugging, .embers, .slash in styles.css); this file adds the DOM pieces, toggles the classes
//   and removes the card when the animation is over. The millisecond constants below must match the
//   animation durations in styles.css or the card disappears early or lingers.
// Accessibility: with prefers-reduced-motion the effects collapse to a 250 ms fade.
import { faceSvg, faceWord } from "./faces.js";

// Honour the OS "reduce motion" setting: the effects below then just fade the card.
// Evaluated on every call (not cached) so a settings change takes effect immediately.
const reduced = () =>
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

// Overlay the outcome face and caption on the card.
/**
 * @param {HTMLElement} card
 * @param {'allow'|'deny'|'neutral'} kind - which face/caption to show (see faces.js LOOK).
 * @returns {void} appends a .seal-mark overlay using the owner's character (card.dataset.style).
 */
function stamp(card, kind) {
  const mark = document.createElement("div");
  mark.className = `seal-mark ${kind}`;
  mark.innerHTML = `${faceSvg(kind, card.dataset.style)}<span>${faceWord(kind)}</span>`;
  card.appendChild(mark);
}

// Remove the card after its animation (duration in ms must match the CSS), resolving when done.
/**
 * @param {HTMLElement} card
 * @param {number} ms - animation length; removal happens exactly then.
 * @returns {Promise<void>} resolves after the card was removed.
 */
function finish(card, ms) {
  return new Promise((resolve) => setTimeout(() => { card.remove(); resolve(); }, ms));
}

// Random sparks for the burn effect; CSS custom property --drift gives each a sideways wobble.
/**
 * @param {HTMLElement} card
 * @param {number} [count=14] - number of sparks.
 * @returns {void} each spark gets a random position, drift and a delay of 650-910 ms so the sparks
 *   start when the flame reaches them (the delay is timed to the burn animation).
 */
function embers(card, count = 14) {
  const box = document.createElement("div");
  box.className = "embers";
  for (let i = 0; i < count; i++) {
    const e = document.createElement("i");
    e.style.left = `${5 + Math.random() * 90}%`;
    e.style.bottom = `${Math.random() * 40}%`;
    e.style.setProperty("--drift", `${(Math.random() - 0.5) * 60}px`);
    e.style.animationDelay = `${650 + Math.random() * 260}ms`;
    box.appendChild(e);
  }
  card.appendChild(box);
}

// Allow effect: mark the card as leaving (so other code leaves it alone), stamp, glide away (~1 s).
/**
 * @param {HTMLElement} card - card whose ask was allowed.
 * @returns {Promise<void>} resolves when the card has been removed.
 */
export function seal(card) {
  card.dataset.leaving = "1";
  card.style.pointerEvents = "none";
  if (reduced()) { card.style.opacity = "0"; return finish(card, 250); }
  card.classList.remove("dragging");
  card.style.transform = "";
  stamp(card, "allow");
  card.classList.add("sealing");
  return finish(card, 1000);
}

// Deny effect: stamp, slash, embers, burn (~1.55 s) and a short vibration where supported.
/**
 * @param {HTMLElement} card - card whose ask was denied.
 * @returns {Promise<void>} resolves when the card has been removed.
 */
export function burn(card) {
  card.dataset.leaving = "1";
  card.style.pointerEvents = "none";
  if (reduced()) { card.style.opacity = "0"; return finish(card, 250); }
  card.classList.remove("dragging");
  card.style.transform = "";
  stamp(card, "deny");
  const slash = document.createElement("div");
  slash.className = "slash";
  card.appendChild(slash);
  embers(card);
  card.classList.add("burning");
  if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([12, 30, 40]);
  return finish(card, 1550);
}

// Redirect effect: neutral face, then the card lifts away (~1.15 s).
/**
 * @param {HTMLElement} card - card whose ask was redirected.
 * @returns {Promise<void>} resolves when the card has been removed.
 */
export function shrug(card) {
  card.dataset.leaving = "1";
  card.style.pointerEvents = "none";
  if (reduced()) { card.style.opacity = "0"; return finish(card, 250); }
  card.classList.remove("dragging");
  card.style.transform = "";
  stamp(card, "neutral");
  card.classList.add("shrugging");
  return finish(card, 1150);
}

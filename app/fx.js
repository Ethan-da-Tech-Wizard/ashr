// Effects for decisions. Each one stamps a face on the card, then the card leaves.
// Allow = thumbs up, then the card glides away. Deny = thumbs down, a fire slash, then it burns.
// Redirect = a neutral face, then the card lifts away.
import { faceSvg, faceWord } from "./faces.js";

// Honour the OS "reduce motion" setting: the effects below then just fade the card.
const reduced = () =>
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

// Overlay the outcome face and caption on the card.
function stamp(card, kind) {
  const mark = document.createElement("div");
  mark.className = `seal-mark ${kind}`;
  mark.innerHTML = `${faceSvg(kind, card.dataset.style)}<span>${faceWord(kind)}</span>`;
  card.appendChild(mark);
}

// Remove the card after its animation (duration in ms must match the CSS), resolving when done.
function finish(card, ms) {
  return new Promise((resolve) => setTimeout(() => { card.remove(); resolve(); }, ms));
}

// Random sparks for the burn effect; CSS custom property --drift gives each a sideways wobble.
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

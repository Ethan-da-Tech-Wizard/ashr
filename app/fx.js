// Program: ashr - fx.js
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Visual effects played on a request card after a decision: a stamp then glide-away for allow, fire for deny, and a lift for redirect.
// Effects for decisions. Each one stamps a face on the card, then the card leaves.
// Allow = thumbs up, then the card glides away. Deny = thumbs down, a fire slash, then it burns.
// Redirect = a neutral face, then the card lifts away.
// faceSvg draws the result tile; faceWord gives its caption.
import { faceSvg, faceWord } from "./faces.js";

// True when the user's system asks for less animation; then we just fade the card out.
const reduced = () =>
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

// Add the result tile and its word on top of the card.
function stamp(card, kind) {
  const mark = document.createElement("div");
  mark.className = `seal-mark ${kind}`;
  mark.innerHTML = `${faceSvg(kind, card.dataset.style)}<span>${faceWord(kind)}</span>`;
  card.appendChild(mark);
}

// Remove the card from the page after ms milliseconds; the returned promise resolves when that happens.
function finish(card, ms) {
  return new Promise((resolve) => setTimeout(() => { card.remove(); resolve(); }, ms));
}

// Add small ember dots at random spots; each gets a random sideways drift and a start delay for the fire effect.
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

// Allow effect: stamp a thumbs up, then let the CSS animation glide the card away. Returns a promise.
export function seal(card) {
  // Mark the card as leaving so other code leaves it alone, and stop it reacting to touches.
  card.dataset.leaving = "1";
  card.style.pointerEvents = "none";
  // Reduced motion: fade out quickly and finish.
  if (reduced()) { card.style.opacity = "0"; return finish(card, 250); }
  card.classList.remove("dragging");
  card.style.transform = "";
  stamp(card, "allow");
  card.classList.add("sealing");
  return finish(card, 1000);
}

// Deny effect: stamp a thumbs down, draw a fire slash, scatter embers and burn the card away.
export function burn(card) {
  card.dataset.leaving = "1";
  card.style.pointerEvents = "none";
  if (reduced()) { card.style.opacity = "0"; return finish(card, 250); }
  card.classList.remove("dragging");
  card.style.transform = "";
  stamp(card, "deny");
  // The slash line that the CSS animates across the card.
  const slash = document.createElement("div");
  slash.className = "slash";
  card.appendChild(slash);
  embers(card);
  card.classList.add("burning");
  // Give a short vibration on phones that support it.
  if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([12, 30, 40]);
  return finish(card, 1550);
}

// Redirect effect: stamp a neutral face and lift the card away.
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

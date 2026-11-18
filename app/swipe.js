// Program: ashr - swipe.js
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Makes a request card draggable: swipe right to allow, left to deny, with colour washes, stamps and haptics while dragging.
// Swipe a card right to allow, left to deny. Calls onDecide("allow" | "deny").
// Haptic helpers for the decision and the first-touch unlock.
import { hapticAllow, hapticDeny, initHaptics } from "./haptics.js";

const THRESHOLD = 90; // pixels a card must travel sideways to count as a decision

/**
 * Attach drag handling to a card.
 * @param {HTMLElement} card the card element.
 * @param {(behavior: string, fly: Function, reset: Function) => void} onDecide called when a swipe passes the threshold.
 */
export function makeSwipeable(card, onDecide) {
  // Nothing to do without a card.
  if (!card) return;
  // startX is where the finger started, dx how far it has moved sideways, active is true while dragging.
  let startX = 0;
  let dx = 0;
  let active = false;
  // Find the green and red overlays and the ALLOW and DENY stamps inside the card.
  const washAllow = card.querySelector(".wash.allow");
  const washDeny = card.querySelector(".wash.deny");
  const stampAllow = card.querySelector(".stamp.allow");
  const stampDeny = card.querySelector(".stamp.deny");

  // Redraw the card for the current drag: move and tilt it, and fade the matching overlay and stamp in as it nears the threshold.
  const paint = () => {
    // p goes from 0 to 1 as the card approaches the threshold.
    const p = Math.min(Math.abs(dx) / THRESHOLD, 1);
    card.style.transform = dx ? `translateX(${dx}px) rotate(${dx / 28}deg)` : "";
    if (washAllow) washAllow.style.opacity = dx > 0 ? p : 0;
    if (stampAllow) {
      stampAllow.style.opacity = dx > 0 ? p : 0;
      stampAllow.style.transform = `rotate(-12deg) scale(${0.85 + 0.25 * p})`;
    }
    if (washDeny) washDeny.style.opacity = dx < 0 ? p : 0;
    if (stampDeny) {
      stampDeny.style.opacity = dx < 0 ? p : 0;
      stampDeny.style.transform = `rotate(12deg) scale(${0.85 + 0.25 * p})`;
    }
  };

  // Snap the card back to the middle.
  const reset = () => {
    dx = 0;
    card.classList.remove("dragging");
    paint();
  };

  // Finger down: ignore touches on buttons, then start tracking and capture the pointer so moves keep coming.
  card.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, summary, pre")) return;
    initHaptics();
    active = true;
    startX = e.clientX;
    card.classList.add("dragging");
    card.setPointerCapture(e.pointerId);
  });

  // Finger moving: update dx and redraw.
  card.addEventListener("pointermove", (e) => {
    if (!active) return;
    dx = e.clientX - startX;
    paint();
  });

  // Finger up: if the card did not move far enough, snap back. Otherwise play the haptic and report allow (right) or deny (left); the fly function slides the card off screen.
  const end = () => {
    if (!active) return;
    active = false;
    card.classList.remove("dragging");
    if (Math.abs(dx) < THRESHOLD) return reset();
    const behavior = dx > 0 ? "allow" : "deny";
    if (behavior === "allow") hapticAllow();
    else hapticDeny();
    onDecide(behavior, () => {
      card.style.transform = `translateX(${dx > 0 ? 600 : -600}px) rotate(${dx > 0 ? 20 : -20}deg)`;
      card.style.opacity = "0";
    }, reset);
  };

  // Finish on lift; cancel resets.
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", () => { active = false; reset(); });
}

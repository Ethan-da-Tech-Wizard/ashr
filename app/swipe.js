// Swipe a card right to allow, left to deny. Calls onDecide("allow" | "deny").
//
// How it fits: app.js buildCard() calls makeSwipeable(card, card.decideWith). The card markup comes
//   from card.js (it contains the .wash and .stamp elements animated here) and styles.css sets
//   `touch-action: pan-y` on cards, which is REQUIRED so the browser keeps vertical scrolling but
//   leaves sideways movement to this script (test/app-touch.test.mjs checks that CSS rule).
// Design: Pointer Events give one code path for touch, pen and mouse. The card follows the
//   finger (translate + slight rotate); past THRESHOLD pixels it counts as a decision, otherwise it
//   snaps back. Effects (fire/seal) and the network call live in app.js and fx.js.
import { hapticAllow, hapticDeny, initHaptics } from "./haptics.js";

// 90px is roughly a thumb flick on a phone and well above accidental drift while tapping.
const THRESHOLD = 90; // pixels a card must travel sideways to count as a decision

// Add drag-to-decide to a card using pointer events (one code path for touch and mouse).
// Dragging right past THRESHOLD allows, left denies; shorter drags snap back.
// onDecide(behavior, fly, reset): `fly` animates the card off screen, `reset` returns it.
/**
 * @param {HTMLElement} card - card element created by app.js buildCard.
 * @param {(behavior: 'allow'|'deny', fly: Function, reset: Function) => void} onDecide - called once
 *   when a drag passes THRESHOLD; `fly` animates the card off-screen, `reset` snaps it back.
 * @returns {void} (does nothing for a falsy card)
 */
export function makeSwipeable(card, onDecide) {
  if (!card) return;
  // startX: pointer x at press; dx: current horizontal offset; active: a drag is in progress.
  let startX = 0;
  let dx = 0;
  let active = false;
  const washAllow = card.querySelector(".wash.allow");
  const washDeny = card.querySelector(".wash.deny");
  const stampAllow = card.querySelector(".stamp.allow");
  const stampDeny = card.querySelector(".stamp.deny");

  // Apply the current drag: tilt/translate the card and fade in the matching ALLOW/DENY stamp in proportion to progress (0..1).
  const paint = () => {
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

  // Return the card to rest (also hides the stamps by painting dx = 0).
  const reset = () => {
    dx = 0;
    card.classList.remove("dragging");
    paint();
  };

  // Taps on buttons, summaries and code blocks must not start a drag.
  card.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, summary, pre")) return;
    initHaptics();
    active = true;
    startX = e.clientX;
    card.classList.add("dragging");
    // Keep receiving moves even if the finger leaves the card.
    card.setPointerCapture(e.pointerId);
  });

  // Move: follow the finger. No threshold check here; the decision is made on release.
  card.addEventListener("pointermove", (e) => {
    if (!active) return;
    dx = e.clientX - startX;
    paint();
  });

  // Pointer released: decide, or snap back if the drag was too short. Haptics fire here because
  // this is the user's gesture, which browsers require before allowing audio/vibration.
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

  // pointercancel (the browser took over, e.g. a system gesture) must NOT decide anything.
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", () => { active = false; reset(); });
}

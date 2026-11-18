// Swipe a card right to allow, left to deny. Calls onDecide("allow" | "deny").
import { hapticAllow, hapticDeny, initHaptics } from "./haptics.js";

const THRESHOLD = 90; // pixels a card must travel sideways to count as a decision

export function makeSwipeable(card, onDecide) {
  if (!card) return;
  let startX = 0;
  let dx = 0;
  let active = false;
  const washAllow = card.querySelector(".wash.allow");
  const washDeny = card.querySelector(".wash.deny");
  const stampAllow = card.querySelector(".stamp.allow");
  const stampDeny = card.querySelector(".stamp.deny");

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

  const reset = () => {
    dx = 0;
    card.classList.remove("dragging");
    paint();
  };

  card.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, summary, pre")) return;
    initHaptics();
    active = true;
    startX = e.clientX;
    card.classList.add("dragging");
    card.setPointerCapture(e.pointerId);
  });

  card.addEventListener("pointermove", (e) => {
    if (!active) return;
    dx = e.clientX - startX;
    paint();
  });

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

  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", () => { active = false; reset(); });
}

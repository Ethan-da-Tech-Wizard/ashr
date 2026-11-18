// The character shown after a decision. It is the owner's own character (see character.js)
// on a coloured tile: happy with a thumb up for allow, cross with a thumb down for deny,
// unbothered for redirect. Pure string builders, no DOM, so node can test them.
import { characterParts } from "./character.js";

const LOOK = {
  allow: { top: "#b9ff52", bottom: "#2fb50e", word: "allowed", mood: "happy", hand: "up" },
  deny: { top: "#ff7a66", bottom: "#e0201f", word: "denied", mood: "cross", hand: "down" },
  neutral: { top: "#d2d4dc", bottom: "#7d808d", word: "redirected", mood: "flat" },
};

export const faceWord = (kind) => (LOOK[kind] || LOOK.neutral).word;

export function faceSvg(kind, style = "rays") {
  const k = LOOK[kind] ? kind : "neutral";
  const c = LOOK[k];
  return `<svg class="face-art" viewBox="0 0 64 64" aria-hidden="true">
  <defs><linearGradient id="tile-${k}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${c.top}"/><stop offset="1" stop-color="${c.bottom}"/>
  </linearGradient></defs>
  <rect x="2" y="2" width="60" height="60" rx="17" fill="url(#tile-${k})"/>
  <rect x="2.6" y="2.6" width="58.8" height="58.8" rx="16.4" fill="none" stroke="#fff" stroke-opacity="0.28" stroke-width="1.2"/>
  <g transform="translate(6.4 6.4) scale(0.8)">${characterParts(style, c.mood, c.hand)}</g>
</svg>`;
}

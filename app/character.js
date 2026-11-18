// Program: ashr - character.js
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Draws the app's little character as SVG strings (shared body and eyes, six head shapes, four moods, optional thumb) and picks a head shape from an owner's name.
// One character system for the whole app. Every character shares the same body, eyes and
// line weight on a 64-unit grid. Only the shape on top of the head changes, and that shape
// belongs to a person: all of one owner's agents wear the same one. Colour says which agent.
// Pure string builders, no DOM, so node can test them.

// Colours: INK is the dark eye and line colour, W is white.
const INK = "#15171a";
const W = "#fff";
// Helper that builds one SVG line (path) with round ends, given the path data d and width w.
const stroke = (d, w, color = INK) => `<path d="${d}" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;

// The head shapes. Order matters: styleFor() picks by position.
// The head shapes, each a snippet of SVG drawn on a 64 by 64 grid.
const TOPS = {
  rays: stroke("M32 13v7M21.5 17l3.5 6M42.5 17l-3.5 6", 5, W),
  antenna: `${stroke("M32 24v-8", 3.6, W)}<circle cx="32" cy="13" r="3.6" fill="${W}"/>`,
  ears: `<path d="M17 31l2-13 11 8zM47 31l-2-13-11 8z" fill="${W}" stroke="${W}" stroke-width="2.6" stroke-linejoin="round"/>`,
  nubs: `<circle cx="21" cy="25" r="5.6" fill="${W}"/><circle cx="43" cy="25" r="5.6" fill="${W}"/>`,
  fin: `<path d="M32 12c6 4 8.5 9 7.5 15h-14c-2-6 .5-11 6.5-15z" fill="${W}" stroke="${W}" stroke-width="2" stroke-linejoin="round"/>`,
  crown: `<path d="M20 28l1-12 6 6 5-8 5 8 6-6 1 12z" fill="${W}" stroke="${W}" stroke-width="2.4" stroke-linejoin="round"/>`,
};
// The list of shape names, in order; styleFor() uses this to choose one.
export const STYLES = Object.keys(TOPS);

// The white rounded body plus a light grey shadow along the bottom.
const BODY = `<ellipse cx="32" cy="40" rx="18" ry="15.5" fill="${W}"/>
  <path d="M15.6 46a18 15.5 0 0 0 32.8 0a19 12 0 0 1-32.8 0z" fill="#dde4ec"/>`;
// Two dark oval eyes at height y.
const eyes = (y) => `<ellipse cx="26" cy="${y}" rx="2.5" ry="3.9" fill="${INK}"/><ellipse cx="38" cy="${y}" rx="2.5" ry="3.9" fill="${INK}"/>`;
// A small four-point sparkle in the top right corner.
const SPARK = `<path d="M53 8c.7 3 2.3 4.6 5.3 5.3-3 .7-4.6 2.3-5.3 5.3-.7-3-2.3-4.6-5.3-5.3 3-.7 4.6-2.3 5.3-5.3z" fill="${W}"/>`;
// A thumb drawn at the right edge; up is thumbs up, otherwise it is flipped to point down.
const thumb = (up) => `<g class="thumb ${up ? "up" : "down"}" transform="translate(56 ${up ? 43 : 38}) scale(1 ${up ? 1 : -1})">
    <rect x="-2.6" y="-11.5" width="5.2" height="10.5" rx="2.6" fill="${W}"/><rect x="-4.8" y="-4" width="10" height="9.4" rx="3.8" fill="${W}"/></g>`;

// Moods: each is the SVG for the eyes and mouth in that mood (happy, cross, flat, or the plain idle eyes).
// What the face is doing.
const MOODS = {
  idle: `${eyes(40)}`,
  happy: `${stroke("M23 41q3-5.5 6 0M35 41q3-5.5 6 0", 2.7)}${stroke("M28.5 46q3.5 3 7 0", 2.3)}`,
  cross: `${eyes(41.5)}${stroke("M21 34l8.5 3.8M43 34l-8.5 3.8", 2.7)}${stroke("M29 48.5q3-2.5 6 0", 2.3)}`,
  flat: `${eyes(40.5)}<rect x="21" y="34" width="22" height="6.5" fill="${W}"/>${stroke("M22.5 40.5h7M34.5 40.5h7", 2.3)}${stroke("M28.5 47h7", 2.3)}`,
};

// Stable pick of a head shape from a GitHub name. Same name, same shape, on every phone.
/**
 * Pick a head shape from a GitHub name. The same name always gives the same shape.
 * @param {string} owner the owner login.
 * @returns {string} one of the names in STYLES.
 */
export function styleFor(owner) {
  // Lowercase the name so capital letters do not change the result.
  const name = String(owner || "").toLowerCase();
  // A simple hash: mix each letter into a number that stays below 9973, then use it to choose a shape.
  let h = 7;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return STYLES[h % STYLES.length];
}

// The character alone, on the 64 grid. hand: "up" | "down" | undefined.
/**
 * Build the inside of the character picture (no outer svg tag), so faces.js can reuse it.
 * @param {string} style a head shape name.
 * @param {string} mood idle, happy, cross or flat.
 * @param {"up"|"down"} [hand] add a thumb up or down.
 */
export function characterParts(style, mood = "idle", hand) {
  // Head shape, then body, then the face for the mood; unknown names fall back to defaults.
  const figure = `${TOPS[style] || TOPS.rays}${BODY}${MOODS[mood] || MOODS.idle}`;
  // With a thumb, shift the figure left a little to make room for it.
  const placed = hand ? `<g transform="translate(-5 0)">${figure}</g>${thumb(hand === "up")}` : figure;
  // Idle and happy moods also get the sparkle.
  return `${placed}${mood === "idle" || mood === "happy" ? SPARK : ""}`;
}

/**
 * Wrap the character in a full svg tag.
 * @param {string} style head shape name. @param {string} [mood] mood. @param {"up"|"down"} [hand] thumb.
 * @param {string} [cls] css class for the svg tag.
 * @returns {string} an SVG string.
 */
export function characterSvg(style, mood = "idle", hand, cls = "mark") {
  return `<svg class="${cls}" viewBox="0 0 64 64" aria-hidden="true">${characterParts(style, mood, hand)}</svg>`;
}

// One character system for the whole app. Every character shares the same body, eyes and
// line weight on a 64-unit grid. Only the shape on top of the head changes, and that shape
// belongs to a person: all of one owner's agents wear the same one. Colour says which agent.
// Pure string builders, no DOM, so node can test them.

// How it fits: agents.js draws it on every agent tile, faces.js reuses characterParts() for the
// decision stamps, and app.js stores the chosen head shape in card.dataset.style. There are only six
// shapes (TOPS), picked from a hash of the owner's GitHub name, so a person is recognisable at a glance
// and the choice is the same on every device with no storage.
// Shared colours; everything is drawn on a 64x64 grid so characters scale cleanly.
const INK = "#15171a";
const W = "#fff";
// SVG path helper with round caps/joins, used for lines and mouths.
const stroke = (d, w, color = INK) => `<path d="${d}" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;

// The head shapes. Order matters: styleFor() picks by position.
const TOPS = {
  rays: stroke("M32 13v7M21.5 17l3.5 6M42.5 17l-3.5 6", 5, W),
  antenna: `${stroke("M32 24v-8", 3.6, W)}<circle cx="32" cy="13" r="3.6" fill="${W}"/>`,
  ears: `<path d="M17 31l2-13 11 8zM47 31l-2-13-11 8z" fill="${W}" stroke="${W}" stroke-width="2.6" stroke-linejoin="round"/>`,
  nubs: `<circle cx="21" cy="25" r="5.6" fill="${W}"/><circle cx="43" cy="25" r="5.6" fill="${W}"/>`,
  fin: `<path d="M32 12c6 4 8.5 9 7.5 15h-14c-2-6 .5-11 6.5-15z" fill="${W}" stroke="${W}" stroke-width="2" stroke-linejoin="round"/>`,
  crown: `<path d="M20 28l1-12 6 6 5-8 5 8 6-6 1 12z" fill="${W}" stroke="${W}" stroke-width="2.4" stroke-linejoin="round"/>`,
};
// List of valid style names, in definition order (styleFor indexes into it).
export const STYLES = Object.keys(TOPS);

const BODY = `<ellipse cx="32" cy="40" rx="18" ry="15.5" fill="${W}"/>
  <path d="M15.6 46a18 15.5 0 0 0 32.8 0a19 12 0 0 1-32.8 0z" fill="#dde4ec"/>`;
const eyes = (y) => `<ellipse cx="26" cy="${y}" rx="2.5" ry="3.9" fill="${INK}"/><ellipse cx="38" cy="${y}" rx="2.5" ry="3.9" fill="${INK}"/>`;
// Four-point sparkle shown only on the calm moods (idle, happy).
const SPARK = `<path d="M53 8c.7 3 2.3 4.6 5.3 5.3-3 .7-4.6 2.3-5.3 5.3-.7-3-2.3-4.6-5.3-5.3 3-.7 4.6-2.3 5.3-5.3z" fill="${W}"/>`;
// Thumb gesture; the down thumb is the up thumb mirrored vertically.
const thumb = (up) => `<g class="thumb ${up ? "up" : "down"}" transform="translate(56 ${up ? 43 : 38}) scale(1 ${up ? 1 : -1})">
    <rect x="-2.6" y="-11.5" width="5.2" height="10.5" rx="2.6" fill="${W}"/><rect x="-4.8" y="-4" width="10" height="9.4" rx="3.8" fill="${W}"/></g>`;

// What the face is doing.
const MOODS = {
  idle: `${eyes(40)}`,
  happy: `${stroke("M23 41q3-5.5 6 0M35 41q3-5.5 6 0", 2.7)}${stroke("M28.5 46q3.5 3 7 0", 2.3)}`,
  cross: `${eyes(41.5)}${stroke("M21 34l8.5 3.8M43 34l-8.5 3.8", 2.7)}${stroke("M29 48.5q3-2.5 6 0", 2.3)}`,
  flat: `${eyes(40.5)}<rect x="21" y="34" width="22" height="6.5" fill="${W}"/>${stroke("M22.5 40.5h7M34.5 40.5h7", 2.3)}${stroke("M28.5 47h7", 2.3)}`,
};

// Stable pick of a head shape from a GitHub name. Same name, same shape, on every phone.
// Simple string hash (31x + char, mod 9973) so the choice is deterministic across devices and sessions.
/**
 * @param {string} owner - GitHub login (any case; empty is allowed).
 * @returns {string} one of STYLES. Deterministic: the hash h = (31*h + charCode) mod 9973 is a small
 *   prime modulus keeping numbers tiny; h % 6 chooses the shape.
 */
export function styleFor(owner) {
  const name = String(owner || "").toLowerCase();
  let h = 7;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return STYLES[h % STYLES.length];
}

// The character alone, on the 64 grid. hand: "up" | "down" | undefined.
// Unknown style or mood falls back to defaults so bad input still renders. With a hand, the figure shifts left to make room for it.
/**
 * @param {string} style - key of TOPS; unknown values use 'rays'.
 * @param {'idle'|'happy'|'cross'|'flat'} [mood='idle'] - facial expression.
 * @param {'up'|'down'} [hand] - optional thumb gesture.
 * @returns {string} SVG fragment (no <svg> wrapper) on a 64x64 grid.
 */
export function characterParts(style, mood = "idle", hand) {
  const figure = `${TOPS[style] || TOPS.rays}${BODY}${MOODS[mood] || MOODS.idle}`;
  const placed = hand ? `<g transform="translate(-5 0)">${figure}</g>${thumb(hand === "up")}` : figure;
  return `${placed}${mood === "idle" || mood === "happy" ? SPARK : ""}`;
}

// Wrap the parts in a standalone <svg>; aria-hidden because it is decoration.
/**
 * @param {string} style
 * @param {string} [mood='idle']
 * @param {'up'|'down'} [hand]
 * @param {string} [cls='mark'] - CSS class on the <svg> (styles.css sizes it).
 * @returns {string} complete inline <svg> markup.
 */
export function characterSvg(style, mood = "idle", hand, cls = "mark") {
  return `<svg class="${cls}" viewBox="0 0 64 64" aria-hidden="true">${characterParts(style, mood, hand)}</svg>`;
}

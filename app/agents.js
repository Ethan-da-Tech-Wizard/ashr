// Program: ashr - agents.js
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Builds the HTML strings for the small agent "tiles" (character, colour, GitHub photo and name) shown in the top row and the talk sheet.
// Agent tiles. The character on the tile belongs to the owner (character.js), the tile
// colour says which agent it is, and the owner's GitHub name and photo label it.
// Pure string builders, no DOM, so node can test them.
// Bring in the helpers from character.js that draw the little character picture.
import { characterSvg, styleFor } from "./character.js";

// Escape helper: turns characters that mean something in HTML (& < > " ') into safe text, so
// names from the hub can never inject markup. null/undefined become an empty string.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// A pattern for a valid GitHub username: letters, digits and single dashes, up to 39 characters,
// and it may not start or end with a dash.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

// "zazmattaz-debug" -> "zazmattaz". Returns "" when there is no usable owner.
/**
 * Get the person's short GitHub name from an owner string such as "zazmattaz-debug".
 * @param {string} owner the owner login the hub sent.
 * @returns {string} the part before the first dash, or "" if the owner is missing, invalid or "unknown".
 */
export function ownerName(owner) {
  if (typeof owner !== "string" || !LOGIN.test(owner) || owner === "unknown") return "";
  return owner.split("-")[0];
}

// Build the GitHub avatar URL for an owner (64px square), or "" when there is no usable owner.
export function ownerPhoto(owner) {
  return ownerName(owner) ? `https://github.com/${encodeURIComponent(owner)}.png?size=64` : "";
}

// The tile shown in the top row and in the talk sheet.
/**
 * Build the HTML for one agent tile: the owner's character, a status pip and the owner's photo.
 * @param {object} session one session from the hub state (owner, agent, title, ...).
 * @returns {string} an HTML string.
 */
export function tileHtml(session) {
  // Use the session only if it is a real object, otherwise an empty one, so nothing below can crash.
  const s = session && typeof session === "object" ? session : {};
  const name = ownerName(s.owner);
  const photo = ownerPhoto(s.owner);
  // If we have a photo, make a circle with the owner's first letter as a fallback (data-initial)
  // and an image on top. If the image fails to load, app.js removes it and the letter shows.
  const face = photo
    ? `<span class="face" data-initial="${esc(name[0].toUpperCase())}"><img src="${esc(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></span>`
    : "";
  // The tile: a class for the agent colour, the character drawing, a pip, and the optional face.
  return `<span class="tile ${esc(s.agent || "")}">${characterSvg(styleFor(s.owner))}<span class="pip"></span>${face}</span>`;
}

/**
 * Build the HTML for one agent button in the top row: tile, title, owner handle and state text.
 * @param {object} session one session from the hub state.
 * @param {string} stateWord plain-English state such as "working".
 * @returns {string} an HTML string.
 */
export function agentHtml(session, stateWord = "") {
  const s = session && typeof session === "object" ? session : {};
  const name = ownerName(s.owner);
  return `${tileHtml(s)}
    <span class="name">${esc(s.title || "")}</span>
    ${name ? `<span class="by">@${esc(name)}</span>` : ""}
    <span class="st">${esc(s.agent || "")} · ${esc(stateWord)}</span>`;
}

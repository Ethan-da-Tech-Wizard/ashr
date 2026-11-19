// File: app/agents.js
// Purpose: Build the HTML for an agent tile (character, colour pip, owner photo).
// Escaping is done here because the strings end up in innerHTML.
// Agent tiles. The character on the tile belongs to the owner (character.js), the tile
// colour says which agent it is, and the owner's GitHub name and photo label it.
// Pure string builders, no DOM, so node can test them.
import { characterSvg, styleFor } from "./character.js";

// Escape &, <, >, quotes so names from the hub cannot inject markup.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Same GitHub-login rule the hub uses (hub/owner.mjs); anything else is shown without a name or photo.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

// "zazmattaz-debug" -> "zazmattaz". Returns "" when there is no usable owner.
export function ownerName(owner) {
  if (typeof owner !== "string" || !LOGIN.test(owner) || owner === "unknown") return "";
  return owner.split("-")[0];
}

// Avatar URL for a valid owner login, else "". Uses github.com's public .png endpoint, no API key.
export function ownerPhoto(owner) {
  return ownerName(owner) ? `https://github.com/${encodeURIComponent(owner)}.png?size=64` : "";
}

// The tile shown in the top row and in the talk sheet.
export function tileHtml(session) {
  const s = session && typeof session === "object" ? session : {};
  const name = ownerName(s.owner);
  // The face span carries the initial as a fallback; app.js removes the <img> if the photo fails to load.
  const photo = ownerPhoto(s.owner);
  const face = photo
    ? `<span class="face" data-initial="${esc(name[0].toUpperCase())}"><img src="${esc(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></span>`
    : "";
  return `<span class="tile ${esc(s.agent || "")}">${characterSvg(styleFor(s.owner))}<span class="pip"></span>${face}</span>`;
}

// Tile plus title, owner handle and "<agent> · <state>" text, for the agent row.
export function agentHtml(session, stateWord = "") {
  const s = session && typeof session === "object" ? session : {};
  const name = ownerName(s.owner);
  return `${tileHtml(s)}
    <span class="name">${esc(s.title || "")}</span>
    ${name ? `<span class="by">@${esc(name)}</span>` : ""}
    <span class="st">${esc(s.agent || "")} · ${esc(stateWord)}</span>`;
}

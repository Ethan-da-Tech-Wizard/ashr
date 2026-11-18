// Program: ashr - app.js
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Main script of the phone app: draws the agents, request cards, counters and guard log from the hub's state, and sends allow, deny, redirect, say and stop actions.
// ashr phone app: render state, handle swipes, talk to agents.
// Pull in the helper modules: hub connection, swipe, voice, effects, tiles, haptics, card builders and sheets.
import { subscribe, decide, say, kill, isDemo, authState, onUnpaired } from "./api.js";
import { makeSwipeable } from "./swipe.js";
import { attachVoice } from "./voice.js";
import { seal, burn, shrug } from "./fx.js";
import { agentHtml } from "./agents.js";
import { styleFor } from "./character.js";
import { hapticAlert, initHaptics } from "./haptics.js";
import { wireAiExplain } from "./ai-explain-ui.js";
import { cardHtml, wireCard } from "./card.js";
import { initDecideSheets, initAgentSheet } from "./sheets.js";

// Shortcut: $("id") finds the element with that id.
const $ = (id) => document.getElementById(id);
// Escape helper so text from the hub is shown as text and never as HTML.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Plain words shown for each agent state.
const STATE_WORD = { needs_you: "needs you", working: "working", done: "done", failed: "failed", signed_out: "signed out", idle: "idle" };
// Sort order for the agent row: lower numbers come first, so agents that need you are on the left.
const ORDER = { needs_you: 0, signed_out: 1, failed: 2, working: 3, done: 4, idle: 5 };

// The latest state from the hub: agent sessions, waiting requests (asks) and the guard log.
let state = { sessions: [], asks: [], log: [] };
// The ids of requests we have already seen, used to alert only on new ones.
let seenAsks = new Set();

// Turn a past time (ms) into a short "how long ago" text: seconds, minutes or hours.
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

// Format a time as a short clock time with the AM or PM removed.
function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M/i, "");
}

// Show a small message at the bottom of the screen for under two seconds. The timer is stored on the function so a new toast can cancel the old timer.
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 1800);
}

// Turn change text into HTML: lines that start with + are marked as added, lines that start with - as removed.
function diffHtml(detail) {
  return esc(detail).split("\n").map((l) =>
    l.startsWith("+") ? `<span class="add">${l}</span>` : l.startsWith("-") ? `<span class="del">${l}</span>` : l
  ).join("\n");
}

// Find the session (agent) that made a request; use a placeholder if it is not in the list.
function sessionOf(ask) {
  return state.sessions.find((x) => x.id === ask.sessionId) || { agent: "claude", title: ask.sessionId };
}

// Send a decision to the hub and play the matching effect on the card.
async function sendDecision(ask, behavior, message, fly, reset, redirect = false) {
  // Hold the card while the reply is in flight, so a state refresh can't fade it out
  // before the fire effect plays.
  // Mark the card as pending so a state refresh cannot remove it before the effect plays.
  const card = cards.get(ask.id);
  if (card) card.dataset.pending = "1";
  // Ask the hub. On success: forget the card, play seal (allow), burn (deny) or shrug (redirect), redraw, and show a message.
  try {
    await decide(ask.id, behavior, message);
    if (card) {
      cards.delete(ask.id);
      (redirect ? shrug : behavior === "allow" ? seal : burn)(card);
      renderStack();
    }
    toast(redirect ? "sent. the agent will try it your way" : behavior === "allow" ? "allowed. agent is moving" : "denied. agent was told why");
  // On failure: un-mark the card. 410 means the request already timed out; 401 is handled elsewhere; anything else resets the card and shows an error.
  } catch (err) {
    if (card) delete card.dataset.pending;
    if (err.status === 410) {
      dropCard(ask.id, true);
      toast("that request already timed out");
    } else if (err.status !== 401) {
      reset && reset();
      toast(`could not reach the laptop: ${err.message}`);
    }
  }
}

// Set up the deny and redirect sheets; they call sendDecision when the user confirms.
const { askDeny, askRedo } = initDecideSheets({ onDecision: sendDecision, onToast: toast });

// All cards on screen, by request id.
const cards = new Map();

// Remove a card quietly (fade out) when its request is gone. force skips the "pending" protection.
function dropCard(id, force = false) {
  const card = cards.get(id);
  if (!card) return;
  if (card.dataset.pending && !force) return; // sendDecision will play the effect
  cards.delete(id);
  if (card.dataset.leaving) return; // a fire effect is already removing it
  card.style.pointerEvents = "none";
  card.style.opacity = "0";
  setTimeout(() => card.remove(), 300);
}

// Create the card element for a request: style classes, HTML, drawer, swipe, AI buttons and the "See change" button.
function buildCard(ask) {
  const card = document.createElement("article");
  const s = sessionOf(ask);
  card.className = `card ${s.agent}${ask.risk === "high" ? " high" : ""}${ask.detail && ask.detail !== ask.summary ? " has-diff" : ""}`;
  card.dataset.style = styleFor(s.owner);
  card.innerHTML = cardHtml(ask, s, ago(ask.createdAt));
  wireCard(card);
  // One function that the swipe code and round buttons both call: redo opens the redirect sheet, deny opens the deny sheet, allow sends straight away.
  card.decideWith = (behavior, fly, reset) =>
    behavior === "redo" ? askRedo(ask)
      : behavior === "deny" ? askDeny(ask, fly, reset) : sendDecision(ask, "allow", undefined, fly, reset);
  makeSwipeable(card, card.decideWith);
  wireAiExplain(card, ask);
  const more = card.querySelector('[data-act="diff"]');
  if (more) more.onclick = () => { $("diff-pre").innerHTML = diffHtml(ask.detail); $("diff-sheet").showModal(); };
  return card;
}

// Find the card on top of the stack (depth 0).
// The round buttons act on the top card.
// Return the top card or null.
function topCard() {
  for (const card of cards.values()) if (card.dataset.depth === "0") return card;
  return null;
}
// The three round buttons act on the top card, unless it is already being answered.
$("btn-allow").onclick = () => { const c = topCard(); if (c && !c.dataset.pending) c.decideWith("allow"); };
$("btn-deny").onclick = () => { const c = topCard(); if (c && !c.dataset.pending) c.decideWith("deny"); };
$("btn-redo").onclick = () => { const c = topCard(); if (c && !c.dataset.pending) c.decideWith("redo"); };

// Redraw the stack of cards.
// Keep existing card elements so a swipe in progress and an open diff survive each frame.
// Sort requests (high risk first, then oldest first), remove cards whose request is gone, create cards for new ones and keep the DOM order right.
function renderStack() {
  const stack = $("stack");
  const asks = [...state.asks].sort((a, b) => (b.risk === "high") - (a.risk === "high") || a.createdAt - b.createdAt);
  const ids = new Set(asks.map((a) => a.id));
  for (const id of [...cards.keys()]) if (!ids.has(id)) dropCard(id);
  if (!stack.querySelector(".card") && stack.childNodes.length) stack.textContent = "";
  let ref = stack.firstElementChild;
  // Skip over elements in the stack that are no longer live cards.
  const skipGone = () => { while (ref && ![...cards.values()].includes(ref)) ref = ref.nextElementSibling; };
  for (const ask of asks) {
    let card = cards.get(ask.id);
    if (card) {
      const w = card.querySelector(".waiting");
      if (w) w.textContent = ago(ask.createdAt);
    } else {
      card = buildCard(ask);
      cards.set(ask.id, card);
    }
    skipGone();
    if (ref === card) ref = ref.nextElementSibling;
    else stack.insertBefore(card, ref);
  }
  // Give the first three cards a depth for the stacked look, then show or hide the hint and the buttons.
  let depth = 0;
  for (const ask of asks) {
    const card = cards.get(ask.id);
    if (card) card.dataset.depth = String(Math.min(depth++, 3));
  }
  $("hint").classList.toggle("hidden", asks.length === 0);
  $("decide").classList.toggle("hidden", asks.length === 0);
}

// Update the big counter, its word, the working-agents line and the page title.
function renderHero() {
  const n = state.asks.length;
  const working = state.sessions.filter((s) => s.state === "working").length;
  $("count").textContent = n;
  $("count").classList.toggle("zero", n === 0);
  $("count-word").textContent = n === 1 ? "needs you" : "need you";
  $("count-sub").textContent = `${working} working · ${state.sessions.length} agents`;
  document.title = n ? `(${n}) ashr` : "ashr";
}

// Remove a broken photo so the first-letter fallback shows.
// A photo that fails to load falls back to the owner's first letter.
// For every photo, delete the img element if it fails to load.
function wireFaces(root) {
  root.querySelectorAll(".face img").forEach((img) => { img.onerror = () => img.remove(); });
}

// Redraw the row of agents. A key built from the data lets us skip redrawing when nothing changed, so photos do not flicker.
function renderHerd() {
  const herd = $("herd");
  const list = [...state.sessions].sort((a, b) => (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9));
  const key = JSON.stringify(list.map((s) => [s.id, s.agent, s.title, s.state, s.owner]));
  if (herd.dataset.key === key) return; // unchanged: keep the photos, no flicker
  herd.dataset.key = key;
  herd.innerHTML = list.length ? "" : `<div class="empty">No agents yet. Run scripts/start-agents.sh on the laptop.</div>`;
  // One button per agent; tapping it opens that agent's chat sheet.
  for (const s of list) {
    const b = document.createElement("button");
    b.className = `agent ${esc(s.state)}`;
    b.innerHTML = agentHtml(s, STATE_WORD[s.state] || s.state);
    b.onclick = () => openSheet(s);
    herd.appendChild(b);
  }
  wireFaces(herd);
}

// Redraw the guard log (up to 12 entries) with time, summary and verdict.
function renderLog() {
  const log = $("log");
  const entries = (state.log || []).slice(0, 12);
  log.innerHTML = entries.length ? "" : `<div class="empty">Nothing yet. Safe commands get allowed here on their own.</div>`;
  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "entry";
    const word = e.verdict === "auto" ? "auto ok" : e.verdict;
    row.innerHTML = `<span class="when">${clock(e.at)}</span><span class="what">${esc(e.summary)}</span>
      <span class="verdict ${esc(e.verdict)}">${esc(word)}</span>`;
    log.appendChild(row);
  }
}

// Handle a new state: vibrate for new requests, remember the ids and redraw all parts.
function render() {
  const fresh = state.asks.filter((a) => !seenAsks.has(a.id));
  if (fresh.length && seenAsks.size) hapticAlert();
  seenAsks = new Set(state.asks.map((a) => a.id));
  renderHero();
  renderStack();
  renderHerd();
  renderLog();
}

// Set up the agent chat sheet.
const { openSheet } = initAgentSheet({
  onSay: say,
  onKill: kill,
  onToast: toast,
  wireFaces,
  stateWord: STATE_WORD,
});

// Show a full-screen "not paired" message, once.
function showUnpaired(failed) {
  if (document.querySelector(".unpaired")) return;
  const el = document.createElement("div");
  el.className = "unpaired";
  el.innerHTML = `<img src="icon.svg" alt="" width="56" height="56" />
    <div class="big">not paired</div>
    <div class="sub">${failed ? "That code was used or expired. Run npm run pair on the laptop." : "Scan the QR on the laptop."}</div>`;
  document.body.appendChild(el);
}

// Add hold-to-talk to the chat and redirect text boxes.
attachVoice($("mic"), $("say-text"));
attachVoice($("redo-mic"), $("redo-text"));
// If the token stops working, show the unpaired screen.
onUnpaired(() => showUnpaired(false));
// Without pairing show the message; otherwise connect to the hub and re-render when state arrives. The connection label shows its status.
if (authState === "unpaired" || authState === "pairfailed") {
  showUnpaired(authState === "pairfailed");
} else {
  subscribe((s) => { state = s; render(); }, (c) => {
    $("conn").dataset.state = c;
    $("conn").textContent = c === "demo" ? "demo mode" : c;
  });
  // Every 15 seconds refresh the counters and the agent row.
  setInterval(() => { renderHero(); renderHerd(); }, 15000);
}
// Keyboard shortcuts for desktop: A or right arrow allows, D or left arrow denies. Ignored while typing, with modifier keys or with a dialog open.
// Desktop keyboard shortcuts: Right arrow or 'A' to allow top card, Left arrow or 'D' to deny
window.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!topCard() || document.querySelector("dialog[open]")) return;
  const key = e.key.toLowerCase();
  if (e.key === "ArrowRight" || key === "a") {
    e.preventDefault();
    initHaptics();
    $("btn-allow").click();
  } else if (e.key === "ArrowLeft" || key === "d") {
    e.preventDefault();
    initHaptics();
    $("btn-deny").click();
  }
});

// Update every card's waiting time once per second.
// Live 1-second ticker for timestamps
setInterval(() => {
  for (const ask of state.asks) {
    const card = cards.get(ask.id);
    const w = card?.querySelector(".waiting");
    if (w) w.textContent = ago(ask.createdAt);
  }
}, 1000);

// Print a note in the console when running in demo mode.
if (isDemo) console.info("ashr: demo mode (?demo=1).");

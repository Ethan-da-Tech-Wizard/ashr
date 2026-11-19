// File: app/app.js
// Purpose: Main controller of the phone UI. Holds the latest hub state, renders
// the card stack of pending approvals, the agent "herd", the activity log and the
// header counts, and wires swipes, buttons and keyboard shortcuts to decisions.
// ashr phone app: render state, handle swipes, talk to agents.
//
// How it fits: this is the entry module loaded by app/index.html (type=module). The hub
//   (hub/server.mjs) serves it as a static file. It owns the in-memory `state` snapshot received
//   from api.js (SSE) and re-renders four regions: hero counter (#count...), card stack (#stack),
//   agent "herd" (#herd) and activity log (#log). Gestures live in swipe.js, per-card markup in
//   card.js, decision sheets in sheets.js, effects in fx.js, vibration in haptics.js, voice input
//   in voice.js, AI explanations in ai-explain-ui.js, networking in api.js.
//
// Data flow: hub snapshot -> state -> render() -> DOM. A user decision goes the other way:
//   swipe/button -> card.decideWith -> sendDecision -> api.decide (POST /api/decide) -> the hub
//   removes the ask and the next snapshot drops the card.
//
// Design decisions: cards are kept in a Map and reused between renders so a finger mid-swipe or an
//   open diff is never destroyed by a refresh; server text is always passed through esc() before
//   going into innerHTML; the app polls nothing itself (api.js does) and works with ?demo=1
//   mock data when there is no hub.
// Test: test/app-touch.test.mjs and the card/faces/explain tests cover the helper modules.
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

// Shorthand for getElementById; every id used below exists in app/index.html.
const $ = (id) => document.getElementById(id);
/**
 * HTML-escapes text before it is placed in innerHTML. Session titles, ask summaries and file
 * contents come from agents and may contain markup, so every interpolation goes through this.
 * @param {unknown} s - value to escape (null/undefined become '').
 * @returns {string}
 */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Human wording for each session state.
const STATE_WORD = { needs_you: "needs you", working: "working", done: "done", failed: "failed", signed_out: "signed out", idle: "idle" };
// Sort priority for the agent row: things needing attention come first.
const ORDER = { needs_you: 0, signed_out: 1, failed: 2, working: 3, done: 4, idle: 5 };

// Latest snapshot from the hub (replaced wholesale on every update).
let state = { sessions: [], asks: [], log: [] };
// Ask ids already shown, used to buzz only for genuinely new requests.
let seenAsks = new Set();

// Compact elapsed time such as "45s", "3m", "2h".
/**
 * @param {number} ms - epoch milliseconds of the event.
 * @returns {string} elapsed time since then, '45s' / '3m' / '2h' (never negative, so a slightly
 *   fast phone clock shows '0s').
 */
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

// Local time of day without the AM/PM suffix, for the log column.
/**
 * @param {number} ms - epoch milliseconds.
 * @returns {string} locale time like '3:07' (AM/PM removed to save width in the log column).
 */
function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M/i, "");
}

// Show a short status message; restarting the timer keeps rapid messages readable.
/**
 * @param {string} text - message for the #toast element.
 * @returns {void} visible for 1.8 s; the timer is stored on the function itself so a new toast
 *   cancels the previous one's hide timer.
 */
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 1800);
}

// Escape then colour a diff-like detail text: "+" lines green, "-" lines red. Escaping first prevents injected markup.
/**
 * @param {string} detail - ask.detail text (command, or file path plus new content).
 * @returns {string} HTML-safe markup with +/- lines wrapped in .add/.del spans for #diff-pre.
 */
function diffHtml(detail) {
  return esc(detail).split("\n").map((l) =>
    l.startsWith("+") ? `<span class="add">${l}</span>` : l.startsWith("-") ? `<span class="del">${l}</span>` : l
  ).join("\n");
}

// Session an ask belongs to, with a placeholder if it has not arrived yet.
/**
 * @param {object} ask - pending ask.
 * @returns {object} the owning session, or a stand-in {agent, title} when the session snapshot
 *   has not arrived yet (asks and sessions come in the same snapshot, but this keeps render safe).
 */
function sessionOf(ask) {
  return state.sessions.find((x) => x.id === ask.sessionId) || { agent: "claude", title: ask.sessionId };
}

// Send allow/deny for an ask, then play the matching effect. `fly` and `reset` come from the swipe code
// (reset snaps the card back on failure); `redirect` means "deny but suggest another way".
/**
 * @param {object} ask - ask being answered.
 * @param {'allow'|'deny'} behavior
 * @param {string} [message] - optional reason or redirect instruction typed by the user.
 * @param {Function} [fly] - swipe animation callback (unused here; sheets pass it through).
 * @param {Function} [reset] - snaps a half-swiped card back when sending fails.
 * @param {boolean} [redirect=false] - true for 'redo': sent as a deny with advice.
 * @returns {Promise<void>} never rejects; failures become toasts.
 */
async function sendDecision(ask, behavior, message, fly, reset, redirect = false) {
  // Hold the card while the reply is in flight, so a state refresh can't fade it out
  // before the fire effect plays.
  const card = cards.get(ask.id);
  if (card) card.dataset.pending = "1";
  try {
    await decide(ask.id, behavior, message);
    if (card) {
      cards.delete(ask.id);
      (redirect ? shrug : behavior === "allow" ? seal : burn)(card);
      renderStack();
    }
    toast(redirect ? "sent. the agent will try it your way" : behavior === "allow" ? "allowed. agent is moving" : "denied. agent was told why");
  } catch (err) {
    if (card) delete card.dataset.pending;
    // 410 = the hub already expired or answered it; drop the stale card instead of showing an error.
    if (err.status === 410) {
      dropCard(ask.id, true);
      toast("that request already timed out");
    // 401 is handled globally by showing the "not paired" screen, so no extra toast.
    } else if (err.status !== 401) {
      reset && reset();
      toast(`could not reach the laptop: ${err.message}`);
    }
  }
}

// Sheets (bottom dialogs) that collect the optional message for deny and redo. They call back into
// sendDecision so the reply path is the same for swipes, buttons and sheets.
const { askDeny, askRedo } = initDecideSheets({ onDecision: sendDecision, onToast: toast });

// ask id -> card element. Cards are reused across renders so gestures and open diffs are not interrupted.
const cards = new Map();

// Fade out and remove a card whose ask has gone away, unless a decision is mid-flight (that path plays its own effect).
/**
 * @param {string} id - ask id whose card should disappear.
 * @param {boolean} [force=false] - remove even if a decision is in flight (used for a 410).
 * @returns {void}
 */
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

// Create the DOM card for an ask and attach swipe, AI explain and "see more" behaviour.
/**
 * @param {object} ask - pending ask {id, tool, summary, detail, risk, reasons, createdAt}.
 * @returns {HTMLElement} an <article class="card"> with gestures and buttons wired. The CSS
 *   classes carry meaning: the agent name (colour), `high` (red frame), `has-diff` (shows the
 *   'see more' button when detail adds information beyond the summary).
 */
function buildCard(ask) {
  const card = document.createElement("article");
  const s = sessionOf(ask);
  card.className = `card ${s.agent}${ask.risk === "high" ? " high" : ""}${ask.detail && ask.detail !== ask.summary ? " has-diff" : ""}`;
  card.dataset.style = styleFor(s.owner);
  card.innerHTML = cardHtml(ask, s, ago(ask.createdAt));
  wireCard(card);
  // One entry point used by swipes and buttons: redo and deny open a sheet to collect a message; allow sends immediately.
  card.decideWith = (behavior, fly, reset) =>
    behavior === "redo" ? askRedo(ask)
      : behavior === "deny" ? askDeny(ask, fly, reset) : sendDecision(ask, "allow", undefined, fly, reset);
  makeSwipeable(card, card.decideWith);
  wireAiExplain(card, ask);
  const more = card.querySelector('[data-act="diff"]');
  if (more) more.onclick = () => { $("diff-pre").innerHTML = diffHtml(ask.detail); $("diff-sheet").showModal(); };
  return card;
}

// The round buttons act on the top card.
/**
 * @returns {HTMLElement|null} the front card (data-depth 0, set in renderStack), or null if
 *   there are none. The round Allow/Deny/Redo buttons act on this card.
 */
function topCard() {
  for (const card of cards.values()) if (card.dataset.depth === "0") return card;
  return null;
}
$("btn-allow").onclick = () => { const c = topCard(); if (c && !c.dataset.pending) c.decideWith("allow"); };
$("btn-deny").onclick = () => { const c = topCard(); if (c && !c.dataset.pending) c.decideWith("deny"); };
$("btn-redo").onclick = () => { const c = topCard(); if (c && !c.dataset.pending) c.decideWith("redo"); };

// Keep existing card elements so a swipe in progress and an open diff survive each frame.
/**
 * Re-renders the card stack from state.asks without rebuilding existing cards.
 * @returns {void}
 */
function renderStack() {
  const stack = $("stack");
  // High-risk asks first, then oldest first.
  const asks = [...state.asks].sort((a, b) => (b.risk === "high") - (a.risk === "high") || a.createdAt - b.createdAt);
  const ids = new Set(asks.map((a) => a.id));
  for (const id of [...cards.keys()]) if (!ids.has(id)) dropCard(id);
  if (!stack.querySelector(".card") && stack.childNodes.length) stack.textContent = "";
  // Walk the existing DOM in step with the sorted list and only insert/move cards that are out of place.
  let ref = stack.firstElementChild;
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
  // Depth drives the stacked look; cards past the third share the deepest style.
  let depth = 0;
  for (const ask of asks) {
    const card = cards.get(ask.id);
    if (card) card.dataset.depth = String(Math.min(depth++, 3));
  }
  $("hint").classList.toggle("hidden", asks.length === 0);
  $("decide").classList.toggle("hidden", asks.length === 0);
}

// Update the big count of pending approvals, the subtitle and the tab title.
/**
 * Updates the big pending-count number, its word, the working/agents subtitle and the browser tab
 * title ('(2) ashr' so a background tab shows pending work).
 * @returns {void}
 */
function renderHero() {
  const n = state.asks.length;
  const working = state.sessions.filter((s) => s.state === "working").length;
  $("count").textContent = n;
  $("count").classList.toggle("zero", n === 0);
  $("count-word").textContent = n === 1 ? "needs you" : "need you";
  $("count-sub").textContent = `${working} working · ${state.sessions.length} agents`;
  document.title = n ? `(${n}) ashr` : "ashr";
}

// A photo that fails to load falls back to the owner's first letter.
/**
 * @param {ParentNode} root - container holding `.face img` avatars (GitHub photos).
 * @returns {void}
 */
function wireFaces(root) {
  root.querySelectorAll(".face img").forEach((img) => { img.onerror = () => img.remove(); });
}

/**
 * Re-renders the row of agent chips, most urgent first (see ORDER). A JSON key of the fields that
 * affect appearance is compared first so an unchanged herd does not rebuild the DOM (which would
 * reload avatar photos and flicker).
 * @returns {void}
 */
function renderHerd() {
  const herd = $("herd");
  const list = [...state.sessions].sort((a, b) => (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9));
  const key = JSON.stringify(list.map((s) => [s.id, s.agent, s.title, s.state, s.owner]));
  if (herd.dataset.key === key) return; // unchanged: keep the photos, no flicker
  herd.dataset.key = key;
  herd.innerHTML = list.length ? "" : `<div class="empty">No agents yet. Run scripts/start-agents.sh on the laptop.</div>`;
  for (const s of list) {
    const b = document.createElement("button");
    b.className = `agent ${esc(s.state)}`;
    b.innerHTML = agentHtml(s, STATE_WORD[s.state] || s.state);
    b.onclick = () => openSheet(s);
    herd.appendChild(b);
  }
  wireFaces(herd);
}

// Show the 12 most recent decisions.
/**
 * Re-renders the decision log (hub sends the newest 50; the phone shows 12). Text is escaped
 * through esc() because summaries come from agent commands.
 * @returns {void}
 */
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

// Full UI refresh from `state`. Vibrates only when a new ask appears after the first snapshot.
/**
 * Full UI refresh from `state`. A vibration is triggered only for asks that were not in the previous
 * snapshot, and not for the very first snapshot (seenAsks empty), so opening the app does not buzz.
 * @returns {void}
 */
function render() {
  const fresh = state.asks.filter((a) => !seenAsks.has(a.id));
  if (fresh.length && seenAsks.size) hapticAlert();
  seenAsks = new Set(state.asks.map((a) => a.id));
  renderHero();
  renderStack();
  renderHerd();
  renderLog();
}

// Bottom sheet for one agent (say something, stop it). `openSheet` is used by renderHerd chips.
const { openSheet } = initAgentSheet({
  onSay: say,
  onKill: kill,
  onToast: toast,
  wireFaces,
  stateWord: STATE_WORD,
});

// Full-screen notice when this device has no valid token.
/**
 * @param {boolean} failed - true when a pairing code was presented but rejected (expired or
 *   already used), which changes the hint text.
 * @returns {void} appends a full-screen overlay once; the user must re-pair from the laptop.
 */
function showUnpaired(failed) {
  if (document.querySelector(".unpaired")) return;
  const el = document.createElement("div");
  el.className = "unpaired";
  el.innerHTML = `<img src="icon.svg" alt="" width="56" height="56" />
    <div class="big">not paired</div>
    <div class="sub">${failed ? "That code was used or expired. Run npm run pair on the laptop." : "Scan the QR on the laptop."}</div>`;
  document.body.appendChild(el);
}

// Microphone buttons fill their text boxes via the browser speech API (voice.js; a no-op where
// unsupported). Then pick the startup path from the auth state computed in api.js.
attachVoice($("mic"), $("say-text"));
attachVoice($("redo-mic"), $("redo-text"));
onUnpaired(() => showUnpaired(false));
// Only connect when we have a token (or demo data).
if (authState === "unpaired" || authState === "pairfailed") {
  showUnpaired(authState === "pairfailed");
} else {
  subscribe((s) => { state = s; render(); }, (c) => {
    $("conn").dataset.state = c;
    $("conn").textContent = c === "demo" ? "demo mode" : c;
  });
  // Refresh relative times ('3m' on chips) every 15 s even when no snapshot arrives.
  setInterval(() => { renderHero(); renderHerd(); }, 15000);
}
// Desktop keyboard shortcuts: Right arrow or 'A' to allow top card, Left arrow or 'D' to deny
window.addEventListener("keydown", (e) => {
  // Ignore shortcuts while typing or when a modifier is held (browser shortcuts).
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

// Live 1-second ticker: only the small 'waiting' labels on cards are touched, not the whole UI.
setInterval(() => {
  for (const ask of state.asks) {
    const card = cards.get(ask.id);
    const w = card?.querySelector(".waiting");
    if (w) w.textContent = ago(ask.createdAt);
  }
}, 1000);

if (isDemo) console.info("ashr: demo mode (?demo=1).");

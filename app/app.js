// ashr phone app: render state, handle swipes, talk to agents.
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

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const STATE_WORD = { needs_you: "needs you", working: "working", done: "done", failed: "failed", signed_out: "signed out", idle: "idle" };
const ORDER = { needs_you: 0, signed_out: 1, failed: 2, working: 3, done: 4, idle: 5 };

let state = { sessions: [], asks: [], log: [] };
let seenAsks = new Set();

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M/i, "");
}

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 1800);
}

function diffHtml(detail) {
  return esc(detail).split("\n").map((l) =>
    l.startsWith("+") ? `<span class="add">${l}</span>` : l.startsWith("-") ? `<span class="del">${l}</span>` : l
  ).join("\n");
}

function sessionOf(ask) {
  return state.sessions.find((x) => x.id === ask.sessionId) || { agent: "claude", title: ask.sessionId };
}

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
    if (err.status === 410) {
      dropCard(ask.id, true);
      toast("that request already timed out");
    } else if (err.status !== 401) {
      reset && reset();
      toast(`could not reach the laptop: ${err.message}`);
    }
  }
}

const { askDeny, askRedo } = initDecideSheets({ onDecision: sendDecision, onToast: toast });

const cards = new Map();

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

function buildCard(ask) {
  const card = document.createElement("article");
  const s = sessionOf(ask);
  card.className = `card ${s.agent}${ask.risk === "high" ? " high" : ""}${ask.detail && ask.detail !== ask.summary ? " has-diff" : ""}`;
  card.dataset.style = styleFor(s.owner);
  card.innerHTML = cardHtml(ask, s, ago(ask.createdAt));
  wireCard(card);
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
function topCard() {
  for (const card of cards.values()) if (card.dataset.depth === "0") return card;
  return null;
}
$("btn-allow").onclick = () => { const c = topCard(); if (c && !c.dataset.pending) c.decideWith("allow"); };
$("btn-deny").onclick = () => { const c = topCard(); if (c && !c.dataset.pending) c.decideWith("deny"); };
$("btn-redo").onclick = () => { const c = topCard(); if (c && !c.dataset.pending) c.decideWith("redo"); };

// Keep existing card elements so a swipe in progress and an open diff survive each frame.
function renderStack() {
  const stack = $("stack");
  const asks = [...state.asks].sort((a, b) => (b.risk === "high") - (a.risk === "high") || a.createdAt - b.createdAt);
  const ids = new Set(asks.map((a) => a.id));
  for (const id of [...cards.keys()]) if (!ids.has(id)) dropCard(id);
  if (!stack.querySelector(".card") && stack.childNodes.length) stack.textContent = "";
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
  let depth = 0;
  for (const ask of asks) {
    const card = cards.get(ask.id);
    if (card) card.dataset.depth = String(Math.min(depth++, 3));
  }
  $("hint").classList.toggle("hidden", asks.length === 0);
  $("decide").classList.toggle("hidden", asks.length === 0);
}

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
function wireFaces(root) {
  root.querySelectorAll(".face img").forEach((img) => { img.onerror = () => img.remove(); });
}

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

function render() {
  const fresh = state.asks.filter((a) => !seenAsks.has(a.id));
  if (fresh.length && seenAsks.size) hapticAlert();
  seenAsks = new Set(state.asks.map((a) => a.id));
  renderHero();
  renderStack();
  renderHerd();
  renderLog();
}

const { openSheet } = initAgentSheet({
  onSay: say,
  onKill: kill,
  onToast: toast,
  wireFaces,
  stateWord: STATE_WORD,
});

function showUnpaired(failed) {
  if (document.querySelector(".unpaired")) return;
  const el = document.createElement("div");
  el.className = "unpaired";
  el.innerHTML = `<img src="icon.svg" alt="" width="56" height="56" />
    <div class="big">not paired</div>
    <div class="sub">${failed ? "That code was used or expired. Run npm run pair on the laptop." : "Scan the QR on the laptop."}</div>`;
  document.body.appendChild(el);
}

attachVoice($("mic"), $("say-text"));
attachVoice($("redo-mic"), $("redo-text"));
onUnpaired(() => showUnpaired(false));
if (authState === "unpaired" || authState === "pairfailed") {
  showUnpaired(authState === "pairfailed");
} else {
  subscribe((s) => { state = s; render(); }, (c) => {
    $("conn").dataset.state = c;
    $("conn").textContent = c === "demo" ? "demo mode" : c;
  });
  setInterval(() => { renderHero(); renderHerd(); }, 15000);
}
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

// Live 1-second ticker for timestamps
setInterval(() => {
  for (const ask of state.asks) {
    const card = cards.get(ask.id);
    const w = card?.querySelector(".waiting");
    if (w) w.textContent = ago(ask.createdAt);
  }
}, 1000);

if (isDemo) console.info("ashr: demo mode (?demo=1).");

// Program: ashr - api.js
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: The phone app's connection to the hub: pairs with a one-time code, keeps the session token, posts decisions, and streams live state (or serves demo data).
// Talks to the hub. Pairs once with ?pair=<code>, then sends the session token.
// Demo data shows only with ?demo=1. No token and no demo means "not paired".
// Demo data generator, used only when the page is opened with ?demo=1.
import { createDemo } from "./mock.js";

// True only in a real browser, so this file can also be loaded by node tests without crashing.
const isBrowser = typeof window !== "undefined" && typeof location !== "undefined";
// The name under which the session token is saved in the browser's localStorage.
const TOKEN_KEY = "ashr_token";
// Read the query string of the page address (for example ?pair=1234 or ?demo=1).
const params = new URLSearchParams(isBrowser ? location.search : "");
// Pull out the three things we care about: a one-time pairing code, an old-style token, and the demo flag.
const pairCode = params.get("pair");
const legacy = params.get("t");
const wantsDemo = params.get("demo") === "1";

// Start with a token saved from an earlier visit, if localStorage works and has one.
let token = (isBrowser && typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null) || "";
// Remembers whether trading the pairing code for a token failed.
let pairFailed = false;

// An old-style link carried the token directly in the address: use it and save it.
if (isBrowser && legacy) {
  token = legacy;
  localStorage.setItem(TOKEN_KEY, token);
}
// Top-level await: trade the one-time pairing code for a session token by asking the hub.
if (isBrowser && pairCode && !wantsDemo) {
  // Send the code to the hub as JSON.
  try {
    const res = await fetch("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairCode }),
    });
    // If the hub said OK, read the JSON answer; otherwise use an empty object so the next line fails.
    const body = res.ok ? await res.json().catch(() => ({})) : {};
    // No token in the answer means pairing failed, so jump to the catch block.
    if (!body.token) throw new Error(`pair failed (${res.status})`);
    token = body.token;
    localStorage.setItem(TOKEN_KEY, token);
  // Remember the failure; the app will show a "not paired" screen.
  } catch {
    pairFailed = true;
  }
}
// Remove the pairing code and token from the address bar so they are not left in history or screenshots.
if (isBrowser && (pairCode || legacy)) {
  params.delete("pair");
  params.delete("t");
  const rest = params.toString();
  if (typeof history !== "undefined" && history.replaceState) {
    history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : ""));
  }
}

// Other files read this to know whether we are in demo mode.
export const isDemo = wantsDemo;
// authState is one of "demo", "ok", "unpaired" or "pairfailed".
// "demo" | "ok" | "unpaired" | "pairfailed"
export const authState = wantsDemo ? "demo" : pairFailed ? "pairfailed" : token ? "ok" : "unpaired";

// Build the fake hub only in demo mode.
const demo = isDemo ? createDemo() : null;
// Functions to call when the hub says our token is no longer valid.
const lostListeners = new Set();

// Let app.js register a function to run when we lose our pairing.
export const onUnpaired = (fn) => lostListeners.add(fn);

// Forget the token (memory and storage) and tell every listener we are unpaired.
function authLost() {
  token = null;
  if (typeof localStorage !== "undefined") localStorage.removeItem(TOKEN_KEY);
  lostListeners.forEach((fn) => fn());
}

// Send a JSON POST to the hub with the token. In demo mode the fake hub answers instead.
async function post(path, body) {
  if (demo) return demo.post(path, body);
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  // Turn a bad HTTP status into an Error carrying the status code; a 401 also means we lost pairing.
  if (!res.ok) {
    if (res.status === 401) authLost();
    const err = new Error(`${path} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  // Return the JSON answer, or an empty object if the answer had no JSON.
  return res.json().catch(() => ({}));
}

// Small wrappers, one per hub endpoint. decide: allow or deny a request. say: send text to an agent.
export const decide = (askId, behavior, message) => post("/api/decide", { askId, behavior, message });
export const say = (sessionId, text) => post("/api/say", { sessionId, text });
// kill: stop an agent. explainAsk: ask a model (gemini or grok) to explain a request.
export const kill = (sessionId) => post("/api/kill", { sessionId });
export const explainAsk = (askId, provider) => post("/api/explain", { askId, provider });

// Check whether the stream URL was refused with 401.
// EventSource hides the status code, so ask the stream URL directly after an error.
// Ask the stream URL directly with fetch, then abort at once so we do not keep a connection open.
async function wasRejected(url) {
  const ctl = new AbortController();
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return res.status === 401;
  } catch {
    return false;
  } finally {
    ctl.abort();
  }
}

// onState(state), onConn("live" | "offline" | "demo" | "connecting")
/**
 * Start receiving live state from the hub.
 * @param {(state: object) => void} onState called with each new full state.
 * @param {(status: string) => void} onConn called with the connection status.
 * @returns {() => void} a function that stops everything.
 */
export function subscribe(onState, onConn) {
  // Demo mode: no network, the fake hub pushes the state.
  if (demo) {
    onConn("demo");
    return demo.subscribe(onState);
  }
  // es is the EventSource; retry is the wait before reconnecting; lastFrame is when we last got data.
  let es;
  let retry = 1000;
  let stopped = false;
  let lastFrame = 0;

  // Safety net: if a proxy holds the stream back, poll the state instead.
  // Back-up path: if the stream has been silent for 2.5 seconds, fetch the state with a normal request.
  const poll = async () => {
    if (stopped || !token || Date.now() - lastFrame < 2500) return;
    try {
      const res = await fetch("/api/state", { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) { stopped = true; authLost(); return; }
      if (res.ok) onState(await res.json());
    } catch { /* stream error handler reports offline */ }
  };
  // Run that check every 1.5 seconds.
  const pollTimer = setInterval(poll, 1500);

  // Open (or re-open) the live stream. The token goes in the address because EventSource cannot set headers.
  const open = () => {
    if (stopped || !token) return;
    onConn("connecting");
    const url = `/api/stream?t=${encodeURIComponent(token)}`;
    es = new EventSource(url);
    // When the stream connects, reset the retry delay and report "live".
    es.addEventListener("open", () => { retry = 1000; onConn("live"); });
    // Each "state" event carries the whole state as JSON.
    es.addEventListener("state", (e) => { lastFrame = Date.now(); onState(JSON.parse(e.data)); });
    // On error: report offline, close, and check if the token was rejected; if not, retry with a doubling delay (max 15 s).
    es.addEventListener("error", async () => {
      onConn("offline");
      es.close();
      if (await wasRejected(url)) { stopped = true; authLost(); return; }
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 15000);
    });
  };
  // Start the first connection now.
  open();
  return () => { stopped = true; clearInterval(pollTimer); es && es.close(); };
}

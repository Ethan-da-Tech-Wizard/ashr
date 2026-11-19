// File: app/api.js
// Purpose: The phone app's only network layer. Handles one-time pairing, stores
// the session token, posts decisions to the hub, and keeps a live connection
// (Server-Sent Events with a polling fallback). In demo mode every call is
// answered by the in-browser mock instead.
// Talks to the hub. Pairs once with ?pair=<code>, then sends the session token.
// Demo data shows only with ?demo=1. No token and no demo means "not paired".
import { createDemo } from "./mock.js";

// This module is also imported by node tests, where there is no window; every browser-only step is guarded by this flag.
const isBrowser = typeof window !== "undefined" && typeof location !== "undefined";
// localStorage key holding the session token that survives page reloads.
const TOKEN_KEY = "ashr_token";
const params = new URLSearchParams(isBrowser ? location.search : "");
const pairCode = params.get("pair");
// Older links passed the token directly as ?t=; still accepted.
const legacy = params.get("t");
const wantsDemo = params.get("demo") === "1";

let token = (isBrowser && typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null) || "";
let pairFailed = false;

if (isBrowser && legacy) {
  token = legacy;
  localStorage.setItem(TOKEN_KEY, token);
}
// Redeem the single-use pairing code from the QR link for a session token.
if (isBrowser && pairCode && !wantsDemo) {
  try {
    const res = await fetch("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairCode }),
    });
    const body = res.ok ? await res.json().catch(() => ({})) : {};
    if (!body.token) throw new Error(`pair failed (${res.status})`);
    token = body.token;
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    pairFailed = true;
  }
}
// Remove the code/token from the address bar afterwards so it is not left in history, screenshots or shared links.
if (isBrowser && (pairCode || legacy)) {
  params.delete("pair");
  params.delete("t");
  const rest = params.toString();
  if (typeof history !== "undefined" && history.replaceState) {
    history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : ""));
  }
}

export const isDemo = wantsDemo;
// "demo" | "ok" | "unpaired" | "pairfailed"
export const authState = wantsDemo ? "demo" : pairFailed ? "pairfailed" : token ? "ok" : "unpaired";

const demo = isDemo ? createDemo() : null;
const lostListeners = new Set();

// Register a callback to run when the hub rejects our token (e.g. it was revoked).
export const onUnpaired = (fn) => lostListeners.add(fn);

// Forget the stored token and tell listeners the app must be re-paired.
function authLost() {
  token = null;
  if (typeof localStorage !== "undefined") localStorage.removeItem(TOKEN_KEY);
  lostListeners.forEach((fn) => fn());
}

// POST JSON to the hub with the Bearer token. A 401 triggers re-pairing; other
// failures throw an Error carrying `.status` so callers can react (e.g. 410 = expired).
async function post(path, body) {
  if (demo) return demo.post(path, body);
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    if (res.status === 401) authLost();
    const err = new Error(`${path} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json().catch(() => ({}));
}

// Thin wrappers for each hub endpoint.
export const decide = (askId, behavior, message) => post("/api/decide", { askId, behavior, message });
export const say = (sessionId, text) => post("/api/say", { sessionId, text });
export const kill = (sessionId) => post("/api/kill", { sessionId });
export const explainAsk = (askId, provider) => post("/api/explain", { askId, provider });

// EventSource hides the status code, so ask the stream URL directly after an error.
async function wasRejected(url) {
  // Abort right after the status line so the stream is not actually held open.
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
// Start receiving live state. Returns an unsubscribe function.
export function subscribe(onState, onConn) {
  if (demo) {
    onConn("demo");
    return demo.subscribe(onState);
  }
  let es;
  // Reconnect delay; doubles after each failure up to 15 s, and resets once the stream opens.
  let retry = 1000;
  let stopped = false;
  let lastFrame = 0;

  // Safety net: if a proxy holds the stream back, poll the state instead.
  const poll = async () => {
    if (stopped || !token || Date.now() - lastFrame < 2500) return;
    try {
      const res = await fetch("/api/state", { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) { stopped = true; authLost(); return; }
      if (res.ok) onState(await res.json());
    } catch { /* stream error handler reports offline */ }
  };
  const pollTimer = setInterval(poll, 1500);

  const open = () => {
    if (stopped || !token) return;
    onConn("connecting");
    const url = `/api/stream?t=${encodeURIComponent(token)}`;
    es = new EventSource(url);
    es.addEventListener("open", () => { retry = 1000; onConn("live"); });
    es.addEventListener("state", (e) => { lastFrame = Date.now(); onState(JSON.parse(e.data)); });
    // Distinguish "token rejected" (stop, re-pair) from "network down" (retry with backoff).
    es.addEventListener("error", async () => {
      onConn("offline");
      es.close();
      if (await wasRejected(url)) { stopped = true; authLost(); return; }
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 15000);
    });
  };
  open();
  return () => { stopped = true; clearInterval(pollTimer); es && es.close(); };
}

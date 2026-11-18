// Talks to the hub. Pairs once with ?pair=<code>, then sends the session token.
// Demo data shows only with ?demo=1. No token and no demo means "not paired".
import { createDemo } from "./mock.js";

const isBrowser = typeof window !== "undefined" && typeof location !== "undefined";
const TOKEN_KEY = "ashr_token";
const params = new URLSearchParams(isBrowser ? location.search : "");
const pairCode = params.get("pair");
const legacy = params.get("t");
const wantsDemo = params.get("demo") === "1";

let token = (isBrowser && typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null) || "";
let pairFailed = false;

if (isBrowser && legacy) {
  token = legacy;
  localStorage.setItem(TOKEN_KEY, token);
}
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

export const onUnpaired = (fn) => lostListeners.add(fn);

function authLost() {
  token = null;
  if (typeof localStorage !== "undefined") localStorage.removeItem(TOKEN_KEY);
  lostListeners.forEach((fn) => fn());
}

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

export const decide = (askId, behavior, message) => post("/api/decide", { askId, behavior, message });
export const say = (sessionId, text) => post("/api/say", { sessionId, text });
export const kill = (sessionId) => post("/api/kill", { sessionId });
export const explainAsk = (askId, provider) => post("/api/explain", { askId, provider });

// EventSource hides the status code, so ask the stream URL directly after an error.
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
export function subscribe(onState, onConn) {
  if (demo) {
    onConn("demo");
    return demo.subscribe(onState);
  }
  let es;
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

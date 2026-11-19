// ==============================================================================
// Program: state.mjs
// Programmer: Ethan-da-Tech-Wizard
// Last Modified: November 18, 2026
// Purpose: In-memory hub state and pending ask queue management
// ==============================================================================
// In-memory hub state: sessions, asks, decision log, held permission requests, SSE clients.
import { randomBytes } from 'node:crypto';

// The decision log keeps only the newest 50 entries.
const LOG_MAX = 50;

// Create the hub's in-memory store. Nothing is persisted; a restart clears it.
// `holdMs` is how long a permission request waits for the phone before it is
// denied automatically (just under typical hook timeouts); `owner` labels sessions.
export function createState({ holdMs = 110_000, owner = 'unknown' } = {}) {
  const sessions = new Map();
  const asks = new Map();
  // holds = asks backed by a live, waiting hook HTTP request (as opposed to demo asks).
  const holds = new Map(); // askId -> { resolve, timer }
  const log = [];
  // Open SSE response objects that receive every state change.
  const clients = new Set();

  // Full state as sent to the phone: sessions newest-updated first, asks oldest first, recent log.
  const snapshot = () => ({
    sessions: [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    asks: [...asks.values()].sort((a, b) => a.createdAt - b.createdAt),
    log: log.slice(0, LOG_MAX),
  });

  // Broadcast a snapshot as an SSE "state" event to every client, pruning dead connections.
  const emit = () => {
    const frame = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) {
      if (res.writableEnded || res.destroyed) {
        clients.delete(res);
        continue;
      }
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
      }
    }
  };

  // Newest first, max 50. verdict: allow | deny | auto | timeout
  const addLog = (sessionId, summary, verdict) => {
    log.unshift({ at: Date.now(), sessionId, summary, verdict });
    if (log.length > LOG_MAX) log.pop();
  };

  // Create or update a session. Defaults apply only on first creation; later patches overlay.
  const upsertSession = (id, patch) => {
    const prev = sessions.get(id) ?? { id, agent: 'claude', title: id, cwd: '', state: 'idle', tmux: '', owner };
    const next = { ...prev, ...patch, id, updatedAt: Date.now() };
    sessions.set(id, next);
    return next;
  };

  const openAskCount = (sessionId) => [...asks.values()].filter((a) => a.sessionId === sessionId).length;

  // Remove an ask, optionally log the verdict, and return the session to `newState` once it has no other open asks.
  const finishAsk = (askId, verdict, newState = 'working') => {
    const ask = asks.get(askId);
    if (!ask) return null;
    asks.delete(askId);
    if (verdict) addLog(ask.sessionId, ask.summary, verdict);
    if (sessions.has(ask.sessionId) && !openAskCount(ask.sessionId)) upsertSession(ask.sessionId, { state: newState });
    return ask;
  };

  // Registers an ask without holding a hook open (used by fake agents).
  const addAsk = (fields) => {
    const ask = {
      id: `ask_${randomBytes(4).toString('hex')}`,
      createdAt: Date.now(),
      reasons: [],
      risk: 'medium',
      ...fields,
    };
    asks.set(ask.id, ask);
    upsertSession(ask.sessionId, { state: 'needs_you' });
    return ask;
  };

  // Holds a real hook request. Resolves with { behavior, message? }.
  const holdAsk = (fields) => {
    const ask = addAsk(fields);
    // If no one answers in time the ask is denied with verdict "timeout", so an agent is never left waiting forever.
    const decision = new Promise((resolve) => {
      const timer = setTimeout(() => settle(ask.id, { behavior: 'deny', message: 'No answer from phone in time' }, 'timeout'), holdMs);
      holds.set(ask.id, { resolve, timer });
    });
    emit();
    return { ask, decision };
  };

  // Single exit point for resolving a held ask (answer, timeout): stop the timer, resolve the waiting hook, clean up, notify clients.
  function settle(askId, decision, verdict) {
    const hold = holds.get(askId);
    if (hold) {
      clearTimeout(hold.timer);
      holds.delete(askId);
      hold.resolve(decision);
    }
    finishAsk(askId, verdict);
    emit();
  }

  // Apply the phone's allow/deny. Returns false if the ask is already gone.
  const decide = (askId, behavior, message) => {
    if (!asks.has(askId)) return false;
    const msg = behavior === 'deny' ? `Denied from phone${message ? `: ${message}` : ''}` : undefined;
    settle(askId, { behavior, message: msg }, behavior);
    return true;
  };

  // The hook connection dropped (agent gave up or user answered in the terminal).
  const cancelAsk = (askId) => {
    const hold = holds.get(askId);
    if (!hold) return;
    clearTimeout(hold.timer);
    holds.delete(askId);
    hold.resolve({ behavior: 'cancel' });
    finishAsk(askId, null);
    emit();
  };

  // Drop a session's un-held (demo) asks; asks with a live hook are left to their own lifecycle.
  const clearSessionAsks = (sessionId) => {
    for (const a of [...asks.values()]) if (a.sessionId === sessionId && !holds.has(a.id)) asks.delete(a.id);
  };

  return { sessions, asks, log, clients, snapshot, emit, addLog, upsertSession, addAsk, holdAsk, decide, cancelAsk, clearSessionAsks };
}

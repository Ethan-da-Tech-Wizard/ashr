// Program: ashr - state.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Keeps the hub's in-memory state: agent sessions, waiting requests (asks), the decision log, held permission hooks and connected event-stream clients.
// In-memory hub state: sessions, asks, decision log, held permission requests, SSE clients.
// Used to make random ask ids.
import { randomBytes } from 'node:crypto';

// The log keeps at most 50 entries.
const LOG_MAX = 50;

// Create a fresh state object. holdMs is how long a request waits for the phone before it is denied; owner is the default GitHub name for new sessions.
export function createState({ holdMs = 110_000, owner = 'unknown' } = {}) {
  // The data: sessions and asks by id, holds (the promise controls of waiting hooks), the log list, and the connected clients.
  const sessions = new Map();
  const asks = new Map();
  const holds = new Map(); // askId -> { resolve, timer }
  const log = [];
  const clients = new Set();

  // A plain copy of the state for the phone: sessions newest first, asks oldest first, and the log.
  const snapshot = () => ({
    sessions: [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    asks: [...asks.values()].sort((a, b) => a.createdAt - b.createdAt),
    log: log.slice(0, LOG_MAX),
  });

  // Send the snapshot to every connected stream client and forget any that are closed or fail.
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

  // Add a log entry at the front and drop the oldest if there are more than 50.
  // Newest first, max 50. verdict: allow | deny | auto | timeout
  const addLog = (sessionId, summary, verdict) => {
    log.unshift({ at: Date.now(), sessionId, summary, verdict });
    if (log.length > LOG_MAX) log.pop();
  };

  // Create or update a session, filling in defaults for new ones and always stamping updatedAt.
  const upsertSession = (id, patch) => {
    const prev = sessions.get(id) ?? { id, agent: 'claude', title: id, cwd: '', state: 'idle', tmux: '', owner };
    const next = { ...prev, ...patch, id, updatedAt: Date.now() };
    sessions.set(id, next);
    return next;
  };

  // How many asks are waiting for a session.
  const openAskCount = (sessionId) => [...asks.values()].filter((a) => a.sessionId === sessionId).length;

  // Remove an ask, log the verdict (if any), and set the session state (default "working") when it has no other open asks.
  const finishAsk = (askId, verdict, newState = 'working') => {
    const ask = asks.get(askId);
    if (!ask) return null;
    asks.delete(askId);
    if (verdict) addLog(ask.sessionId, ask.summary, verdict);
    if (sessions.has(ask.sessionId) && !openAskCount(ask.sessionId)) upsertSession(ask.sessionId, { state: newState });
    return ask;
  };

  // Add an ask without holding a hook open (used by the fake agents).
  // Registers an ask without holding a hook open (used by fake agents).
  // Make an ask with an id, a time and defaults, then mark its session as needing the user.
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

  // Add an ask and return a promise that resolves with the decision.
  // Holds a real hook request. Resolves with { behavior, message? }.
  // If nobody answers within holdMs the ask is denied with the verdict "timeout".
  const holdAsk = (fields) => {
    const ask = addAsk(fields);
    const decision = new Promise((resolve) => {
      const timer = setTimeout(() => settle(ask.id, { behavior: 'deny', message: 'No answer from phone in time' }, 'timeout'), holdMs);
      holds.set(ask.id, { resolve, timer });
    });
    emit();
    return { ask, decision };
  };

  // Finish an ask: stop its timer, resolve the waiting promise, log the verdict and tell the clients.
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

  // Apply the phone's decision. Returns false for an unknown ask. A deny gets a "Denied from phone" message.
  const decide = (askId, behavior, message) => {
    if (!asks.has(askId)) return false;
    const msg = behavior === 'deny' ? `Denied from phone${message ? `: ${message}` : ''}` : undefined;
    settle(askId, { behavior, message: msg }, behavior);
    return true;
  };

  // If the waiting hook disconnected, cancel its ask without logging anything.
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

  // Remove asks of a session that are not held by a real hook (demo asks).
  const clearSessionAsks = (sessionId) => {
    for (const a of [...asks.values()]) if (a.sessionId === sessionId && !holds.has(a.id)) asks.delete(a.id);
  };

  // Expose everything the rest of the hub needs.
  return { sessions, asks, log, clients, snapshot, emit, addLog, upsertSession, addAsk, holdAsk, decide, cancelAsk, clearSessionAsks };
}

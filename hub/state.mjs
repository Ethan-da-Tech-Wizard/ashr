// ==============================================================================
// Program: state.mjs
// Programmer: Ethan-da-Tech-Wizard
// Last Modified: November 18, 2026
// Purpose: In-memory hub state and pending ask queue management
//
// How it fits: server.mjs creates one store with createState() and hands it to every route
//   handler as ctx.state. routes.mjs mutates it (upsertSession, holdAsk, decide...) and the
//   server's SSE endpoint registers response objects in `clients`; every mutation calls
//   emit() so each connected phone gets a fresh snapshot. The store never touches the
//   network or disk itself.
//
// Data model (see docs/CONTRACT.md): a SESSION is one agent run (id, agent, title, cwd,
//   state, tmux pane, owner, updatedAt); an ASK is one pending permission request
//   (id, sessionId, tool, summary, detail, risk, reasons, createdAt); the LOG is the last
//   50 decisions. A HOLD is the live HTTP request of the agent that is waiting on an ask.
//
// Invariants: an ask id is unique and removed exactly once; settle() is the only place a
//   held ask is resolved, so a request can never be answered twice; a session returns to
//   `working` only when it has no other open asks.
//
// Known limits: nothing persists across restarts; the log and ask lists are unbounded
//   except the log cap (the open-ask cap of 20 is enforced in routes.mjs).
// Test: test/hub.test.mjs and test/fuzz.test.mjs exercise it through the HTTP API.
// ==============================================================================
// In-memory hub state: sessions, asks, decision log, held permission requests, SSE clients.
import { randomBytes } from 'node:crypto';

// The decision log keeps only the newest 50 entries.
const LOG_MAX = 50;

// Create the hub's in-memory store. Nothing is persisted; a restart clears it.
// `holdMs` is how long a permission request waits for the phone before it is
// denied automatically (just under typical hook timeouts); `owner` labels sessions.
/**
 * @param {object} [options]
 * @param {number} [options.holdMs=110000] - ms to wait for a phone answer before denying;
 *   chosen just under the 120 s hook timeout in hooks/claude-settings.json so the hub, not
 *   the agent, is the one that gives up first.
 * @param {string} [options.owner='unknown'] - default owner stamped on new sessions.
 * @returns {object} store with maps `sessions`, `asks`, array `log`, Set `clients` and the
 *   functions snapshot, emit, addLog, upsertSession, addAsk, holdAsk, decide, cancelAsk,
 *   clearSessionAsks.
 */
export function createState({ holdMs = 110_000, owner = 'unknown' } = {}) {
  // sessions: id -> session object. asks: id -> ask object (insertion order is irrelevant;
  // snapshot sorts by createdAt).
  const sessions = new Map();
  const asks = new Map();
  // holds = asks backed by a live, waiting hook HTTP request (as opposed to demo asks).
  const holds = new Map(); // askId -> { resolve, timer }
  const log = [];
  // Open SSE response objects that receive every state change.
  const clients = new Set();

  // Full state as sent to the phone: sessions newest-updated first, asks oldest first, recent log.
  /**
   * @returns {{sessions: object[], asks: object[], log: object[]}} plain copies safe to
   *   JSON.stringify; the arrays are new, the objects inside are the live ones (do not mutate).
   */
  const snapshot = () => ({
    sessions: [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    asks: [...asks.values()].sort((a, b) => a.createdAt - b.createdAt),
    log: log.slice(0, LOG_MAX),
  });

  // Broadcast a snapshot as an SSE "state" event to every client, pruning dead connections.
  /**
   * Pushes the current snapshot to every SSE client. Dead connections found while writing
   * are removed here so a closed phone tab cannot leak an entry forever.
   * @returns {void}
   */
  const emit = () => {
    // Serialise once and reuse the same string for every client (cheaper than per-client JSON).
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
  /**
   * @param {string} sessionId - session the decision belongs to.
   * @param {string} summary - one-line description shown in the phone's history.
   * @param {'allow'|'deny'|'auto'|'timeout'} verdict - 'auto' means the guard allowed it
   *   without asking; 'timeout' means no answer arrived in time.
   * @returns {void}
   */
  const addLog = (sessionId, summary, verdict) => {
    log.unshift({ at: Date.now(), sessionId, summary, verdict });
    if (log.length > LOG_MAX) log.pop();
  };

  // Create or update a session. Defaults apply only on first creation; later patches overlay.
  /**
   * @param {string} id - session id (`<agent>-<6 chars>`).
   * @param {object} patch - fields to overlay (agent, title, cwd, state, tmux, owner...).
   * @returns {object} the stored session (a new object each call; updatedAt is refreshed so
   *   snapshot() sorts recently active sessions first).
   */
  const upsertSession = (id, patch) => {
    const prev = sessions.get(id) ?? { id, agent: 'claude', title: id, cwd: '', state: 'idle', tmux: '', owner };
    const next = { ...prev, ...patch, id, updatedAt: Date.now() };
    sessions.set(id, next);
    return next;
  };

  // Number of asks still waiting for this session (used to decide when it stops needing you).
  const openAskCount = (sessionId) => [...asks.values()].filter((a) => a.sessionId === sessionId).length;

  // Remove an ask, optionally log the verdict, and return the session to `newState` once it has no other open asks.
  /**
   * @param {string} askId
   * @param {string|null} verdict - logged when truthy; null means 'withdrawn, not a decision'.
   * @param {string} [newState='working'] - state to give the session if this was its last ask.
   * @returns {object|null} the removed ask, or null if it was already gone (idempotent).
   */
  const finishAsk = (askId, verdict, newState = 'working') => {
    const ask = asks.get(askId);
    if (!ask) return null;
    asks.delete(askId);
    if (verdict) addLog(ask.sessionId, ask.summary, verdict);
    if (sessions.has(ask.sessionId) && !openAskCount(ask.sessionId)) upsertSession(ask.sessionId, { state: newState });
    return ask;
  };

  // Registers an ask without holding a hook open (used by fake agents).
  /**
   * @param {object} fields - sessionId (required) plus tool, summary, detail, risk, reasons.
   * @returns {object} the stored ask; its session is marked `needs_you`. Does not emit; the
   *   caller does, after finishing its own updates.
   */
  const addAsk = (fields) => {
    const ask = {
      // 32 random bits: unique enough for at most a few dozen live asks, short for the UI.
      id: `ask_${randomBytes(4).toString('hex')}`,
      // Defaults first, caller's fields last so they win.
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
  /**
   * @param {object} fields - same as addAsk.
   * @returns {{ask: object, decision: Promise<{behavior: string, message?: string}>}} the
   *   promise resolves exactly once: allow/deny from decide(), a deny on timeout, or
   *   {behavior:'cancel'} if the agent disconnected first.
   */
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
  /**
   * @param {string} askId
   * @param {{behavior: string, message?: string}} decision - what to give the waiting hook.
   * @param {string} verdict - 'allow' | 'deny' | 'timeout', recorded in the log.
   * @returns {void} safe to call for an ask that has no hold (e.g. a demo ask).
   */
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
  /**
   * @param {string} askId
   * @param {'allow'|'deny'} behavior - already validated by routes.apiDecide.
   * @param {string} [message] - optional reason typed on the phone, appended to the deny text.
   * @returns {boolean} true if the ask existed and was settled.
   */
  const decide = (askId, behavior, message) => {
    if (!asks.has(askId)) return false;
    const msg = behavior === 'deny' ? `Denied from phone${message ? `: ${message}` : ''}` : undefined;
    settle(askId, { behavior, message: msg }, behavior);
    return true;
  };

  // The hook connection dropped (agent gave up or user answered in the terminal).
  /**
   * Called when the hook's HTTP connection closes before an answer. It resolves the
   * waiting promise with 'cancel' (the route ignores the reply: the socket is gone) and
   * removes the ask without logging, since no decision was made.
   * @param {string} askId
   * @returns {void}
   */
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
  /**
   * @param {string} sessionId
   * @returns {void} deletes only demo asks; does not emit (the caller does).
   */
  const clearSessionAsks = (sessionId) => {
    for (const a of [...asks.values()]) if (a.sessionId === sessionId && !holds.has(a.id)) asks.delete(a.id);
  };

  // Public surface: the raw maps are exposed deliberately so route handlers and tests can
  // read them; mutate only through the functions.
  return { sessions, asks, log, clients, snapshot, emit, addLog, upsertSession, addAsk, holdAsk, decide, cancelAsk, clearSessionAsks };
}

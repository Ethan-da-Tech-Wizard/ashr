// ==============================================================================
// File: hub/routes.mjs
// Purpose: the endpoint handlers behind every hub URL (hooks from agents, calls from the phone).
//
// How it fits: server.mjs owns HTTP plumbing (who may call, body parsing, JSON replies) and
//   dispatches here through its POST table. Handlers call guard/rules.mjs `score()` to rate
//   a tool call, mutate ctx.state (state.mjs), type into tmux (tmux.mjs), push notifications
//   (notify.mjs), write the audit vault (aws-vault.mjs) and ask an AI to explain a request
//   (ai-explain.mjs). The request and reply shapes are specified in docs/CONTRACT.md.
//
// Endpoint groups: /hook/* is for local agents (permission, event, fake demo data, pair-code,
//   agent-token issue/revoke); /api/* is for the paired phone (pair, decide, say, kill, explain).
//
// Fail-closed policy: if the hub cannot decide (queue full, timeout, bad input) the reply is a
//   deny, never an allow. Unknown input is rejected with 4xx rather than guessed at.
// Test: test/hub.test.mjs, test/agent-tokens.test.mjs, test/fuzz.test.mjs, test/hub-auth.test.mjs.
// ==============================================================================

// Endpoint handlers. Each handler gets (ctx, req, body) and returns { status, json } or handles res itself.
// Handler contract: each exported handler is async (ctx, req, body[, res]) and returns { status, json }.
// ctx carries { state, tmux, auth, port, announce, baseUrl }. Validation is strict: every
// string from a client is length-checked via str() before use.
import { score } from '../guard/rules.mjs';
import { typeInto, interrupt, validTarget } from './tmux.mjs';
import { notifyAsk } from './notify.mjs';
import { validOwner } from './owner.mjs';
import { recordDecisionToVault } from './aws-vault.mjs';
import { requestAiExplanation } from './ai-explain.mjs';

// Response bodies in the shape the Claude Code PermissionRequest hook expects.
// Constant allow reply (shared, never mutated) and a builder for deny replies; both
// match the `hookSpecificOutput.decision` shape documented in docs/CONTRACT.md.
const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
const denyBody = (message) => ({
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } },
});

// Return v only if it is a string of at most `max` chars, else null.
/**
 * Strict string validator used on every client-supplied field.
 * @param {unknown} v - value from a request body.
 * @param {number} max - maximum allowed length in UTF-16 units.
 * @returns {string|null} v if it is a string no longer than max, otherwise null (so callers
 *   can use `str(x, n) || default` or test for null to reject).
 */
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
// Whitelists for client-controlled enums; anything outside them is ignored or rejected.
const AGENTS = new Set(['claude', 'codex', 'gemini', 'grok']);
const STATES = new Set(['needs_you', 'working', 'done', 'failed', 'signed_out', 'idle']);
// Cap on concurrently pending asks, so a runaway agent cannot flood the phone.
const MAX_OPEN_ASKS = 20;
const RISKS = new Set(['low', 'medium', 'high']);

// Derive a stable session id and a state patch from a hook payload. The agent
// name comes from body, then the x-ashr-agent header, then the token, then 'claude'.
// The id is `<agent>-<first 6 alnum chars of session_id>` so it is short and safe to display.
/**
 * @param {object} ctx - hub context (reads ctx.state.sessions to keep existing titles).
 * @param {object} body - parsed hook JSON (agent, session_id, cwd, title...).
 * @param {http.IncomingMessage} req - headers x-ashr-agent and x-ashr-pane.
 * @param {object} [tokenSession] - metadata of the verified agent token, if any.
 * @returns {{id: string, patch: object}} session id and the fields to merge into it. The
 *   pane header is applied only when validTarget() accepts it, because it is later passed to tmux.
 */
function claudeSession(ctx, body, req, tokenSession) {
  const reqAgent = str(req.headers['x-ashr-agent'], 20);
  const tokenAgent = tokenSession?.agentId && AGENTS.has(tokenSession.agentId)
    ? tokenSession.agentId
    : (tokenSession?.agentId ? [...AGENTS].find((a) => tokenSession.agentId.startsWith(a)) : null);
  const agent = AGENTS.has(body.agent) ? body.agent : (reqAgent && AGENTS.has(reqAgent) ? reqAgent : (tokenAgent || 'claude'));
  const sid = str(body.session_id, 200) || 'unknown';
  const id = `${agent}-${sid.replace(/[^\w]/g, '').slice(0, 6) || 'x'}`;
  // The tmux pane arrives from a header set by the agent's hook config ($TMUX_PANE). It is
  // untrusted text, so only well-formed pane/window ids are stored.
  const pane = req.headers['x-ashr-pane'];
  const patch = { agent };
  if (typeof body.cwd === 'string') patch.cwd = body.cwd.slice(0, 500);
  if (validTarget(pane)) patch.tmux = pane;
  if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.slice(0, 200);
  else if (!ctx.state.sessions.has(id)) patch.title = (patch.cwd || id).split('/').filter(Boolean).pop() || id;
  return { id, patch };
}

// Check the optional Bearer token on a hook request. Returns null when no
// Authorization header is present (localhost hooks are allowed tokenless),
// { session } when valid, or { error } with 401/403 when a token is bad,
// lacks the capability, or belongs to a different agent.
/**
 * @param {object} ctx - hub context (uses ctx.auth.getSession).
 * @param {http.IncomingMessage} req
 * @param {string} requiredCapability - e.g. 'hook:permission'; a token needs it or '*'.
 * @param {string|null} sessionAgent - agent name claimed by the request, compared to a
 *   token that was minted for one specific agent.
 * @returns {null | {session: object} | {error: {status: number, json: object}}}
 */
function verifyAgentToken(ctx, req, requiredCapability, sessionAgent) {
  const authHeader = req.headers?.authorization;
  // Tokenless localhost hooks are allowed by design (server.mjs already restricted /hook/* to
  // loopback), which keeps plain Claude Code HTTP hooks working with zero setup. A header that
  // IS present must be valid, so a stale token fails loudly instead of silently downgrading.
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!m) {
    return { error: { status: 401, json: { error: 'invalid or expired agent token' } } };
  }
  const token = m[1].trim();
  const session = ctx.auth.getSession(token);
  if (!session) {
    return { error: { status: 401, json: { error: 'invalid or expired agent token' } } };
  }
  const caps = session.capabilities || [];
  if (!caps.includes('*') && !caps.includes(requiredCapability)) {
    return { error: { status: 403, json: { error: 'insufficient token capabilities' } } };
  }
  // Generic ids (agent, fixed, phone, *) are not tied to one agent; only specifically named tokens are matched.
  if (session.agentId && session.agentId !== '*' && session.agentId !== 'agent' && session.agentId !== 'fixed' && session.agentId !== 'phone') {
    if (sessionAgent) {
      const match = session.agentId === sessionAgent ||
        session.agentId.startsWith(sessionAgent) ||
        sessionAgent.startsWith(session.agentId);
      if (!match) {
        return { error: { status: 403, json: { error: 'agent mismatch' } } };
      }
    }
  }
  return { session };
}

// POST /hook/agent-token (localhost only): mint a scoped, expiring token for an agent.
/**
 * @param {object} ctx
 * @param {http.IncomingMessage} req - unused.
 * @param {{agentId?: string, role?: string, ttlMs?: number, capabilities?: string[]}} body
 *   all optional; defaults give a one-hour worker token with hook:permission and hook:event.
 * @returns {Promise<{status: number, json: object}>} the plaintext token is returned ONCE; only
 *   its SHA-256 digest is stored.
 */
export async function hookAgentToken(ctx, req, body = {}) {
  const agentId = typeof body?.agentId === 'string' && body.agentId.trim() ? body.agentId.trim() : 'agent';
  const role = typeof body?.role === 'string' && body.role.trim() ? body.role.trim() : 'worker';
  const ttlMs = typeof body?.ttlMs === 'number' && body.ttlMs > 0 ? body.ttlMs : undefined;
  const capabilities = Array.isArray(body?.capabilities) && body.capabilities.every((c) => typeof c === 'string')
    ? body.capabilities
    : ['hook:permission', 'hook:event'];

  const issued = ctx.auth.issueAgentToken({
    agentId,
    role,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    capabilities,
  });

  return {
    status: 200,
    json: {
      ok: true,
      token: issued.token,
      agentId: issued.agentId || agentId,
      role,
      expiresAt: issued.expiresAt,
      capabilities,
    },
  };
}

// POST /hook/agent-token/revoke: invalidate a token.
/**
 * @param {object} ctx
 * @param {http.IncomingMessage} req - unused.
 * @param {{token?: string}} body
 * @returns {Promise<{status: number, json: {ok: true, revoked: boolean}}>} revoked is false
 *   for an unknown token; both outcomes are 200 so a caller cannot probe which tokens exist.
 */
export async function hookAgentTokenRevoke(ctx, req, body = {}) {
  const token = typeof body?.token === 'string' ? body.token : '';
  const revoked = ctx.auth.revoke(token);
  return {
    status: 200,
    json: {
      ok: true,
      revoked: Boolean(revoked),
    },
  };
}

// POST /hook/permission: the heart of ashr. Scores the requested tool call;
// low risk is auto-allowed, otherwise the request is held open until the
// phone answers (or times out and is denied). Every outcome is audited.
/**
 * @param {object} ctx
 * @param {http.IncomingMessage} req
 * @param {object} body - Claude-style hook JSON: tool_name, tool_input, cwd, session_id...
 * @param {http.ServerResponse} res - watched for 'close' so a hung-up agent withdraws its ask.
 * @returns {Promise<{status: number, json: object}>} resolves when the phone answers, when the
 *   hold times out (deny), or immediately for low-risk calls (allow) and a full queue (deny).
 *   A non-2xx reply (bad token) is returned as-is.
 */
export async function hookPermission(ctx, req, body, res) {
  const bodyAgent = body && typeof body.agent === 'string' ? body.agent : (req.headers && req.headers['x-ashr-agent'] ? req.headers['x-ashr-agent'] : null);
  const authRes = verifyAgentToken(ctx, req, 'hook:permission', bodyAgent);
  if (authRes?.error) return authRes.error;

  const { id, patch } = claudeSession(ctx, body, req, authRes?.session);
  ctx.state.upsertSession(id, patch);
  // Rate the call: { risk: low|medium|high, summary, detail, reasons }. Low risk never
  // bothers the human; everything else must be answered.
  const verdict = await score({ tool: body.tool_name, input: body.tool_input, cwd: body.cwd });
  if (verdict.risk === 'low') {
    // Auto-allow still leaves a trace: a log line for the phone and an audit-vault record
    // (best effort, `.catch` so a vault failure cannot block the agent).
    ctx.state.addLog(id, verdict.summary, 'auto');
    ctx.state.emit();
    recordDecisionToVault({ sessionId: id, tool: body.tool_name, summary: verdict.summary, risk: verdict.risk, decision: 'auto' }).catch(() => {});
    return { status: 200, json: ALLOW };
  }
  // Fail closed: with too many open asks, deny rather than queue unboundedly.
  if (ctx.state.asks.size >= MAX_OPEN_ASKS) {
    ctx.state.addLog(id, verdict.summary, 'deny');
    ctx.state.emit();
    return { status: 200, json: denyBody('ashr queue full') };
  }
  // Park the request: the agent's HTTP call stays open (up to holdMs) until the phone decides.
  const { ask, decision } = ctx.state.holdAsk({
    sessionId: id,
    tool: String(body.tool_name ?? ''),
    summary: verdict.summary,
    detail: verdict.detail,
    risk: verdict.risk,
    reasons: verdict.reasons,
  });
  // Fire-and-forget push notification; failure must not affect the decision.
  notifyAsk(ask).catch(() => {});
  // If the agent hangs up before we answer, withdraw the ask from the phone.
  res.on('close', () => { if (!res.writableEnded) ctx.state.cancelAsk(ask.id); });
  // Blocks here. 'cancel' (agent hung up) also lands in the deny branch, harmlessly: the
  // socket is already closed.
  const d = await decision;
  return { status: 200, json: d.behavior === 'allow' ? ALLOW : denyBody(d.message ?? 'Denied from phone') };
}

// POST /hook/event: map Claude Code lifecycle events to a session state shown on the phone.
/**
 * @param {object} ctx
 * @param {http.IncomingMessage} req
 * @param {object} body - hook JSON with hook_event_name (UserPromptSubmit, SessionStart, Stop,
 *   Notification) and event-specific fields.
 * @returns {Promise<{status: number, json: object}>} 200 {} on success; unknown events only
 *   refresh the session's timestamp.
 */
export async function hookEvent(ctx, req, body) {
  const bodyAgent = body && typeof body.agent === 'string' ? body.agent : (req.headers && req.headers['x-ashr-agent'] ? req.headers['x-ashr-agent'] : null);
  const authRes = verifyAgentToken(ctx, req, 'hook:event', bodyAgent);
  if (authRes?.error) return authRes.error;

  const { id, patch } = claudeSession(ctx, body, req, authRes?.session);
  const event = body.hook_event_name;
  const s = ctx.state;
  // Use the first prompt as a title only while the title is still a placeholder (id or folder name), so later prompts do not rename the session.
  if (event === 'UserPromptSubmit') {
    patch.state = 'working';
    const prompt = str(body.prompt, 100_000);
    const known = s.sessions.get(id);
    if (prompt && (!known || known.title === known.id || known.title === (known.cwd || '').split('/').pop())) {
      patch.title = prompt.replace(/\s+/g, ' ').slice(0, 48);
    }
  } else if (event === 'SessionStart') patch.state = 'idle';
  else if (event === 'Stop') patch.state = 'done';
  else if (event === 'Notification') {
    const t = body.notification_type;
    if (t === 'permission_prompt' || t === 'idle_prompt') patch.state = 'needs_you';
    else if (t === 'agent_completed') patch.state = 'done';
    else if (t === 'auth_storage_failure') patch.state = 'signed_out';
  }
  s.upsertSession(id, patch);
  s.emit();
  return { status: 200, json: {} };
}

// Localhost-only demo hook: { session: {id?, agent, title, state, cwd?, owner?}, ask?: {tool, summary, detail, risk, reasons} }
/**
 * Fabricates sessions and asks for demos and scripts/fake-agents.mjs; no real agent involved.
 * @param {object} ctx
 * @param {http.IncomingMessage} req - unused.
 * @param {object} body - see the shape in the comment above.
 * @returns {Promise<{status: number, json: object}>} 400 when session.agent is not whitelisted.
 */
export async function hookFake(ctx, req, body) {
  const sess = body.session && typeof body.session === 'object' ? body.session : null;
  if (!sess || !AGENTS.has(sess.agent)) return { status: 400, json: { error: 'session.agent must be claude|codex|gemini' } };
  const id = str(sess.id, 64) || `${sess.agent}-demo`;
  const patch = { agent: sess.agent };
  if (str(sess.title, 120)) patch.title = sess.title;
  if (str(sess.cwd, 500)) patch.cwd = sess.cwd;
  if (validOwner(sess.owner)) patch.owner = sess.owner;
  if (STATES.has(sess.state)) patch.state = sess.state;
  ctx.state.upsertSession(id, patch);
  if (body.ask && typeof body.ask === 'object') {
    const a = body.ask;
    ctx.state.addAsk({
      sessionId: id,
      tool: str(a.tool, 40) || 'Bash',
      summary: str(a.summary, 200) || 'demo action',
      detail: str(a.detail, 5000) || '',
      risk: RISKS.has(a.risk) ? a.risk : 'medium',
      reasons: Array.isArray(a.reasons) ? a.reasons.filter((r) => typeof r === 'string').slice(0, 5) : [],
    });
  } else if (patch.state && patch.state !== 'needs_you') {
    ctx.state.clearSessionAsks(id);
  }
  ctx.state.emit();
  return { status: 200, json: { ok: true, id } };
}

// POST /api/pair: exchange a pairing code for a session token (the only unauthenticated /api route).
/**
 * @param {object} ctx
 * @param {http.IncomingMessage} req - unused.
 * @param {{code?: string}} body
 * @returns {Promise<{status: number, json: {token?: string, error?: string}}>} 401 for a bad or
 *   used code, 429 after too many failures (auth.mjs rate limit).
 */
export async function apiPair(ctx, req, body) {
  const out = ctx.auth.redeem(body.code);
  if (out.error) return { status: out.status, json: { error: out.error } };
  return { status: 200, json: { token: out.token } };
}

// Localhost-only: issue a fresh pair code, print it (with QR) on the hub terminal, return the URL.
/**
 * @param {object} ctx - uses ctx.auth, ctx.baseUrl, ctx.port and ctx.announce.
 * @returns {Promise<{status: number, json: {url: string}}>} the pairing URL for the new code.
 */
export async function hookPairCode(ctx) {
  const code = ctx.auth.newCode();
  const base = (ctx.baseUrl ? ctx.baseUrl() : `http://127.0.0.1:${ctx.port}`).replace(/\/$/, '');
  const url = `${base}/?pair=${code}`;
  ctx.announce(code, url);
  return { status: 200, json: { url } };
}

// POST /api/decide: phone allows or denies a pending ask. 410 means it already expired or was answered.
/**
 * @param {object} ctx
 * @param {http.IncomingMessage} req - unused.
 * @param {{askId?: string, behavior?: 'allow'|'deny', message?: string}} body
 * @returns {Promise<{status: number, json: object}>} 400 invalid input, 410 unknown ask, else
 *   200 and the agent's held request is released. The decision is also appended to the audit vault.
 */
export async function apiDecide(ctx, req, body) {
  const askId = str(body.askId, 64);
  if (!askId) return { status: 400, json: { error: 'askId required' } };
  const ask = ctx.state.asks.get(askId);
  if (!ask) return { status: 410, json: { error: 'expired' } };
  if (body.behavior !== 'allow' && body.behavior !== 'deny') return { status: 400, json: { error: 'behavior must be allow|deny' } };
  const message = body.message === undefined ? undefined : str(body.message, 500);
  if (message === null) return { status: 400, json: { error: 'message too long' } };
  ctx.state.decide(askId, body.behavior, message);
  recordDecisionToVault({ sessionId: ask.sessionId, tool: ask.tool, summary: ask.summary, risk: ask.risk, decision: body.behavior, message }).catch(() => {});
  return { status: 200, json: { ok: true } };
}

// POST /api/explain: ask Gemini or Grok to explain an ask in plain English. Works
// even when the ask is gone if the client resends its summary.
/**
 * @param {object} ctx
 * @param {http.IncomingMessage} req - unused.
 * @param {{askId?: string, provider?: 'gemini'|'grok'}} body - the optional fields summary,
 *   tool, detail, risk and reasons let the phone explain an ask the hub has already forgotten.
 * @returns {Promise<{status: number, json: object}>} `simulated: true` marks a canned
 *   offline explanation (no API key configured), so the UI can label it.
 */
export async function apiExplain(ctx, req, body) {
  const askId = str(body?.askId, 64);
  if (!askId) return { status: 400, json: { error: 'askId required' } };
  const provider = body?.provider === 'grok' ? 'grok' : body?.provider === 'gemini' ? 'gemini' : null;
  if (!provider) return { status: 400, json: { error: 'provider must be gemini|grok' } };

  let ask = ctx.state.asks.get(askId);
  if (!ask && typeof body?.summary === 'string') {
    ask = {
      id: askId,
      tool: str(body?.tool, 40) || 'Bash',
      summary: str(body?.summary, 500) || 'action',
      detail: str(body?.detail, 5000) || '',
      risk: RISKS.has(body?.risk) ? body.risk : 'medium',
      reasons: Array.isArray(body?.reasons) ? body.reasons.filter((r) => typeof r === 'string').slice(0, 5) : [],
    };
  }
  if (!ask) return { status: 410, json: { error: 'expired' } };

  const res = await requestAiExplanation({ ask, provider });
  return {
    status: 200,
    json: {
      ok: true,
      provider: res.provider,
      explanation: res.explanation,
      simulated: !!res.simulated,
    },
  };
}

// Resolve body.sessionId to a session with a valid tmux pane, or an error result (404 unknown, 409 no pane).
/**
 * @param {object} ctx
 * @param {{sessionId?: string}} body
 * @returns {{session: object} | {error: {status: number, json: object}}}
 */
function target(ctx, body) {
  const id = str(body.sessionId, 64);
  const s = id && ctx.state.sessions.get(id);
  if (!s) return { error: { status: 404, json: { error: 'unknown sessionId' } } };
  if (!validTarget(s.tmux)) return { error: { status: 409, json: { error: 'session has no tmux pane' } } };
  return { session: s };
}

// POST /api/say: type a message into the agent's tmux pane. Newlines become spaces so one request is one prompt.
/**
 * @param {object} ctx
 * @param {http.IncomingMessage} req - unused.
 * @param {{sessionId?: string, text?: string}} body - text is 1-2000 characters.
 * @returns {Promise<{status: number, json: object}>} 502 when tmux itself fails. The session
 *   flips to `working` because the agent now has a new instruction.
 */
export async function apiSay(ctx, req, body) {
  const text = str(body.text, 2000);
  if (!text || !text.trim()) return { status: 400, json: { error: 'text required (1-2000 chars)' } };
  const t = target(ctx, body);
  if (t.error) return t.error;
  try {
    await ctx.tmux.typeInto(t.session.tmux, text.replace(/[\r\n]+/g, ' '));
  } catch (e) {
    return { status: 502, json: { error: `tmux failed: ${e.message}` } };
  }
  ctx.state.upsertSession(t.session.id, { state: 'working' });
  ctx.state.emit();
  return { status: 200, json: { ok: true } };
}

// POST /api/kill: send Ctrl-C to the agent's pane.
/**
 * @param {object} ctx
 * @param {http.IncomingMessage} req - unused.
 * @param {{sessionId?: string}} body
 * @returns {Promise<{status: number, json: object}>} 200 after Ctrl-C was sent; 404/409/502
 *   as for apiSay.
 */
export async function apiKill(ctx, req, body) {
  const t = target(ctx, body);
  if (t.error) return t.error;
  try {
    await ctx.tmux.interrupt(t.session.tmux);
  } catch (e) {
    return { status: 502, json: { error: `tmux failed: ${e.message}` } };
  }
  ctx.state.emit();
  return { status: 200, json: { ok: true } };
}

// Re-exported for callers that import tmux helpers via routes.
export { typeInto, interrupt };

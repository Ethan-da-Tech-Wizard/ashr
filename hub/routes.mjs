// Program: ashr - routes.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: The hub's endpoint handlers: agent hooks (permission, event, tokens, fake demo agents), the phone's API (pair, decide, say, kill, explain) and helpers to pick sessions.
// Endpoint handlers. Each handler gets (ctx, req, body) and returns { status, json } or handles res itself.
// Pull in the risk scorer, tmux helpers, notifier, owner check, audit vault and AI explainer.
import { score } from '../guard/rules.mjs';
import { typeInto, interrupt, validTarget } from './tmux.mjs';
import { notifyAsk } from './notify.mjs';
import { validOwner } from './owner.mjs';
import { recordDecisionToVault } from './aws-vault.mjs';
import { requestAiExplanation } from './ai-explain.mjs';

// The reply the hub sends to a hook to allow an action, and a function that builds a deny reply with a message.
const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
const denyBody = (message) => ({
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } },
});

// Return the value only if it is a string that is not longer than max, otherwise null.
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
// Allowed values: agent names, session states and risk levels; and the most asks that may wait at once.
const AGENTS = new Set(['claude', 'codex', 'gemini', 'grok']);
const STATES = new Set(['needs_you', 'working', 'done', 'failed', 'signed_out', 'idle']);
const MAX_OPEN_ASKS = 20;
const RISKS = new Set(['low', 'medium', 'high']);

// Work out which session a hook call belongs to: the agent name (from the body, a header or the token), a short session id, and the fields to update (folder, tmux pane, title).
function claudeSession(ctx, body, req, tokenSession) {
  const reqAgent = str(req.headers['x-ashr-agent'], 20);
  const tokenAgent = tokenSession?.agentId && AGENTS.has(tokenSession.agentId)
    ? tokenSession.agentId
    : (tokenSession?.agentId ? [...AGENTS].find((a) => tokenSession.agentId.startsWith(a)) : null);
  const agent = AGENTS.has(body.agent) ? body.agent : (reqAgent && AGENTS.has(reqAgent) ? reqAgent : (tokenAgent || 'claude'));
  const sid = str(body.session_id, 200) || 'unknown';
  const id = `${agent}-${sid.replace(/[^\w]/g, '').slice(0, 6) || 'x'}`;
  const pane = req.headers['x-ashr-pane'];
  const patch = { agent };
  if (typeof body.cwd === 'string') patch.cwd = body.cwd.slice(0, 500);
  if (validTarget(pane)) patch.tmux = pane;
  if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.slice(0, 200);
  else if (!ctx.state.sessions.has(id)) patch.title = (patch.cwd || id).split('/').filter(Boolean).pop() || id;
  return { id, patch };
}

// If the request has a Bearer token, check that it is valid, has the needed capability and matches the agent. Returns null when no token was sent (local hooks may omit it), or an error reply, or the session.
function verifyAgentToken(ctx, req, requiredCapability, sessionAgent) {
  const authHeader = req.headers?.authorization;
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

// Issue a scoped agent token (localhost only), using safe defaults for missing fields.
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

// Revoke an agent token.
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

// The main hook: an agent asks permission for a tool call. Score the call; low risk is allowed and logged straight away. Otherwise the request is held for the phone, a notification is sent, and the reply waits for the user's allow or deny.
export async function hookPermission(ctx, req, body, res) {
  const bodyAgent = body && typeof body.agent === 'string' ? body.agent : (req.headers && req.headers['x-ashr-agent'] ? req.headers['x-ashr-agent'] : null);
  const authRes = verifyAgentToken(ctx, req, 'hook:permission', bodyAgent);
  if (authRes?.error) return authRes.error;

  const { id, patch } = claudeSession(ctx, body, req, authRes?.session);
  ctx.state.upsertSession(id, patch);
  // Scored low: allow. Queue full (20 waiting): deny. Otherwise create a held ask.
  const verdict = await score({ tool: body.tool_name, input: body.tool_input, cwd: body.cwd });
  if (verdict.risk === 'low') {
    ctx.state.addLog(id, verdict.summary, 'auto');
    ctx.state.emit();
    recordDecisionToVault({ sessionId: id, tool: body.tool_name, summary: verdict.summary, risk: verdict.risk, decision: 'auto' }).catch(() => {});
    return { status: 200, json: ALLOW };
  }
  if (ctx.state.asks.size >= MAX_OPEN_ASKS) {
    ctx.state.addLog(id, verdict.summary, 'deny');
    ctx.state.emit();
    return { status: 200, json: denyBody('ashr queue full') };
  }
  const { ask, decision } = ctx.state.holdAsk({
    sessionId: id,
    tool: String(body.tool_name ?? ''),
    summary: verdict.summary,
    detail: verdict.detail,
    risk: verdict.risk,
    reasons: verdict.reasons,
  });
  notifyAsk(ask).catch(() => {});
  // If the agent disconnects while waiting, cancel the ask.
  res.on('close', () => { if (!res.writableEnded) ctx.state.cancelAsk(ask.id); });
  const d = await decision;
  return { status: 200, json: d.behavior === 'allow' ? ALLOW : denyBody(d.message ?? 'Denied from phone') };
}

// Lifecycle hook: update the session state from the event name (prompt submitted, session start, stop, notifications).
export async function hookEvent(ctx, req, body) {
  const bodyAgent = body && typeof body.agent === 'string' ? body.agent : (req.headers && req.headers['x-ashr-agent'] ? req.headers['x-ashr-agent'] : null);
  const authRes = verifyAgentToken(ctx, req, 'hook:event', bodyAgent);
  if (authRes?.error) return authRes.error;

  const { id, patch } = claudeSession(ctx, body, req, authRes?.session);
  const event = body.hook_event_name;
  const s = ctx.state;
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

// Fake agents (for demos and tests) create or update a session and optionally add an ask.
// Localhost-only demo hook: { session: {id?, agent, title, state, cwd?, owner?}, ask?: {tool, summary, detail, risk, reasons} }
// Validate every field before use. A session that is no longer waiting has its demo asks cleared.
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

// Phone trades a pairing code for a token.
export async function apiPair(ctx, req, body) {
  const out = ctx.auth.redeem(body.code);
  if (out.error) return { status: out.status, json: { error: out.error } };
  return { status: 200, json: { token: out.token } };
}

// Create a new pairing code and link, announce it on the hub terminal and return the link.
// Localhost-only: issue a fresh pair code, print it (with QR) on the hub terminal, return the URL.
// Build the pairing URL from the base address and the new code.
export async function hookPairCode(ctx) {
  const code = ctx.auth.newCode();
  const base = (ctx.baseUrl ? ctx.baseUrl() : `http://127.0.0.1:${ctx.port}`).replace(/\/$/, '');
  const url = `${base}/?pair=${code}`;
  ctx.announce(code, url);
  return { status: 200, json: { url } };
}

// Phone's allow or deny for an ask. Gives 410 if the ask is gone, 400 for bad input, and records the decision in the audit vault.
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

// Ask Gemini or Grok to explain an ask. If the hub no longer has the ask, one can be rebuilt from the request body.
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

// Find the session and check that it has a valid tmux pane; otherwise an error reply.
function target(ctx, body) {
  const id = str(body.sessionId, 64);
  const s = id && ctx.state.sessions.get(id);
  if (!s) return { error: { status: 404, json: { error: 'unknown sessionId' } } };
  if (!validTarget(s.tmux)) return { error: { status: 409, json: { error: 'session has no tmux pane' } } };
  return { session: s };
}

// Type the phone's message into the agent's tmux pane (line breaks become spaces) and mark the agent as working.
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

// Send Ctrl-C to the agent's tmux pane.
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

// Re-export the tmux helpers for tests.
export { typeInto, interrupt };

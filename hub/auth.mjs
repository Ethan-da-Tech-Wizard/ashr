// ==============================================================================
// Program: auth.mjs
// Programmer: Ethan-da-Tech-Wizard
// Course: CIS 156 / Advanced Systems
// Last Modified: November 18, 2026
// Purpose: Ephemeral token generation and capability scoping for supervised agents
// ==============================================================================
// Pairing and session tokens. Pair codes are single use and expire after 10 minutes.
// Supports ephemeral per-agent session tokens with TTL and capability scoping.
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const CODE_TTL_MS = 10 * 60_000;
const MAX_CODES = 20;
const FAIL_WINDOW_MS = 60_000;
const MAX_FAILS = 10;
const DEFAULT_AGENT_TOKEN_TTL_MS = 60 * 60_000; // 1 hour

const digest = (s) => createHash('sha256').update(s).digest();

export function createAuth({ fixedToken = '' } = {}) {
  const codes = new Map(); // code -> expiresAt
  const tokens = new Map(); // sha256_hex -> { expiresAt, agentId, role, capabilities }
  const fails = [];

  if (fixedToken) {
    tokens.set(digest(fixedToken).toString('hex'), {
      expiresAt: Infinity,
      agentId: 'fixed',
      role: 'admin',
      capabilities: ['*'],
    });
  }

  const newCode = () => {
    const now = Date.now();
    for (const [c, exp] of codes) if (exp <= now) codes.delete(c);
    while (codes.size >= MAX_CODES) codes.delete(codes.keys().next().value);
    const code = randomBytes(9).toString('base64url');
    codes.set(code, now + CODE_TTL_MS);
    return code;
  };

  // Returns { token } or { error, status }. The code is burned on first valid use.
  const redeem = (code) => {
    const now = Date.now();
    while (fails.length && fails[0] <= now - FAIL_WINDOW_MS) fails.shift();
    if (fails.length >= MAX_FAILS) return { status: 429, error: 'too many attempts' };
    const exp = typeof code === 'string' ? codes.get(code) : undefined;
    if (exp === undefined || exp <= now) {
      if (exp !== undefined) codes.delete(code);
      fails.push(now);
      return { status: 401, error: 'invalid or used code' };
    }
    codes.delete(code);
    const token = randomBytes(24).toString('hex');
    tokens.set(digest(token).toString('hex'), {
      expiresAt: Infinity,
      agentId: 'phone',
      role: 'controller',
      capabilities: ['*'],
    });
    return { token };
  };

  // Issue an ephemeral scoped token for a specific agent (e.g. claude-wt-auth, gemini-arch)
  const issueAgentToken = ({ agentId = 'agent', role = 'worker', ttlMs = DEFAULT_AGENT_TOKEN_TTL_MS, capabilities = ['hook:permission', 'hook:event'] } = {}) => {
    const now = Date.now();
    const token = `ashr_${agentId}_${randomBytes(18).toString('base64url')}`;
    tokens.set(digest(token).toString('hex'), {
      expiresAt: now + ttlMs,
      agentId,
      role,
      capabilities,
    });
    return { token, expiresAt: now + ttlMs, agentId };
  };

  const getSession = (given) => {
    if (!given) return null;
    const now = Date.now();
    const d = digest(given);
    for (const [hash, meta] of tokens.entries()) {
      if (timingSafeEqual(d, Buffer.from(hash, 'hex'))) {
        if (meta.expiresAt <= now) {
          tokens.delete(hash);
          return null;
        }
        return meta;
      }
    }
    return null;
  };

  const valid = (given) => {
    return getSession(given) !== null;
  };

  const revoke = (given) => {
    if (!given) return false;
    const d = digest(given);
    for (const [hash] of tokens.entries()) {
      if (timingSafeEqual(d, Buffer.from(hash, 'hex'))) {
        tokens.delete(hash);
        return true;
      }
    }
    return false;
  };

  return { newCode, redeem, valid, issueAgentToken, getSession, revoke };
}

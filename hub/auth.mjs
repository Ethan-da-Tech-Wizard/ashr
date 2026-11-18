// Program: ashr - auth.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Pairing and session-token handling: one-time pairing codes, phone tokens, short-lived scoped agent tokens, rate limiting of bad codes, and constant-time comparison.
// Pairing and session tokens. Pair codes are single use and expire after 10 minutes.
// Supports ephemeral per-agent session tokens with TTL and capability scoping.
// Crypto helpers: random bytes, safe comparison and hashing.
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';

// Limits: pairing codes last 10 minutes (at most 20 at once), 10 bad attempts per minute are allowed, and agent tokens last 1 hour by default.
const CODE_TTL_MS = 10 * 60_000;
const MAX_CODES = 20;
const FAIL_WINDOW_MS = 60_000;
const MAX_FAILS = 10;
const DEFAULT_AGENT_TOKEN_TTL_MS = 60 * 60_000; // 1 hour

// SHA-256 of a string. Tokens are stored only as hashes.
const digest = (s) => createHash('sha256').update(s).digest();

// Create an auth store. fixedToken (optional) is a permanent admin token, for example from ASHR_TOKEN.
export function createAuth({ fixedToken = '' } = {}) {
  // codes: pairing code to expiry time. tokens: token hash to its details. fails: times of recent bad attempts.
  const codes = new Map(); // code -> expiresAt
  const tokens = new Map(); // sha256_hex -> { expiresAt, agentId, role, capabilities }
  const fails = [];

  // Register the fixed token as an admin token that never expires.
  if (fixedToken) {
    tokens.set(digest(fixedToken).toString('hex'), {
      expiresAt: Infinity,
      agentId: 'fixed',
      role: 'admin',
      capabilities: ['*'],
    });
  }

  // Make a new random pairing code (removing expired ones and the oldest when full).
  const newCode = () => {
    const now = Date.now();
    for (const [c, exp] of codes) if (exp <= now) codes.delete(c);
    while (codes.size >= MAX_CODES) codes.delete(codes.keys().next().value);
    const code = randomBytes(9).toString('base64url');
    codes.set(code, now + CODE_TTL_MS);
    return code;
  };

  // Trade a pairing code for a phone token. Codes work once. Too many recent bad attempts gives 429; a bad or expired code gives 401.
  // Returns { token } or { error, status }. The code is burned on first valid use.
  // Check the rate limit, look up the code, delete it, create a random token and store its hash with phone-controller rights.
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

  // Create a token for one agent with a role, a time limit and a list of capabilities.
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

  // Find the details for a token by comparing its hash in constant time. Expired tokens are deleted and give null.
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

  // True if the token is known and not expired.
  const valid = (given) => {
    return getSession(given) !== null;
  };

  // Delete a token; returns true if it existed.
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

  // The public functions of the auth store.
  return { newCode, redeem, valid, issueAgentToken, getSession, revoke };
}

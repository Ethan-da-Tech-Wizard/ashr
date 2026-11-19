// ==============================================================================
// Program: auth.mjs
// Programmer: Ethan-da-Tech-Wizard
// Last Modified: November 18, 2026
// Purpose: Ephemeral token generation and capability scoping for supervised agents
//
// How it fits: server.mjs creates one auth store per hub with createAuth(). The phone pairs
//   by redeeming a one-time code (routes.apiPair) and receives a session token that
//   server.mjs checks on every /api/* call via valid(); agents may optionally present scoped
//   tokens that routes.verifyAgentToken checks through getSession().
//
// Security design: tokens and codes are random from crypto.randomBytes; tokens are stored only
//   as SHA-256 digests; comparison is constant-time; redeeming is rate limited; codes are
//   single use and short lived. This module has no I/O and no timers (expiry is checked lazily
//   when a token is looked up).
// Known limits: everything is in memory (restart = all phones must re-pair); getSession scans
//   all tokens linearly, fine for a handful of devices.
// Test: test/hub-auth.test.mjs and test/agent-tokens.test.mjs.
// ==============================================================================
// Pairing and session tokens. Pair codes are single use and expire after 10 minutes.
// Supports ephemeral per-agent session tokens with TTL and capability scoping.
// Tokens are stored only as SHA-256 digests, so a memory dump of the hub does not reveal live tokens.
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';

// Pairing codes: valid 10 minutes, at most 20 outstanding at once.
const CODE_TTL_MS = 10 * 60_000;
const MAX_CODES = 20;
// Brute-force limit: more than 10 failed redeems in any 60 s window are answered with HTTP 429.
const FAIL_WINDOW_MS = 60_000;
const MAX_FAILS = 10;
const DEFAULT_AGENT_TOKEN_TTL_MS = 60 * 60_000; // 1 hour

// Fixed-length digest, which also lets timingSafeEqual compare equal-length buffers.
const digest = (s) => createHash('sha256').update(s).digest();

// Create an auth store. `fixedToken` (from ASHR_TOKEN) is an optional never-expiring admin token.
// Returns { newCode, redeem, valid, issueAgentToken, getSession, revoke }.
/**
 * @param {object} [options]
 * @param {string} [options.fixedToken=''] - ASHR_TOKEN value, accepted forever with full rights.
 * @returns {{newCode: () => string, redeem: (code: string) => object, valid: (token: string) => boolean,
 *   issueAgentToken: (options?: object) => {token: string, expiresAt: number, agentId: string},
 *   getSession: (token: string) => (object|null), revoke: (token: string) => boolean}}
 */
export function createAuth({ fixedToken = '' } = {}) {
  const codes = new Map(); // code -> expiresAt
  // Keyed by digest so the plaintext never sits in memory. Values hold the token's scope:
  // agentId (who), role (admin|controller|worker), capabilities (['*'] or hook:* names).
  const tokens = new Map(); // sha256_hex -> { expiresAt, agentId, role, capabilities }
  // Timestamps of recent failed redeems, oldest first.
  const fails = [];

  // The fixed token exists for tests and scripts that cannot pair interactively.
  if (fixedToken) {
    tokens.set(digest(fixedToken).toString('hex'), {
      expiresAt: Infinity,
      agentId: 'fixed',
      role: 'admin',
      capabilities: ['*'],
    });
  }

  // Mint a single-use pairing code. Expired codes are purged and, at the cap, the oldest is evicted so memory stays bounded.
  /**
   * @returns {string} a 12-character base64url code, valid for 10 minutes, one redeem.
   */
  const newCode = () => {
    const now = Date.now();
    for (const [c, exp] of codes) if (exp <= now) codes.delete(c);
    while (codes.size >= MAX_CODES) codes.delete(codes.keys().next().value);
    // 72 bits of randomness, URL-safe so it can sit in a QR-code link.
    const code = randomBytes(9).toString('base64url');
    codes.set(code, now + CODE_TTL_MS);
    return code;
  };

  // Returns { token } or { error, status }. The code is burned on first valid use.
  /**
   * @param {unknown} code - value typed or scanned on the phone.
   * @returns {{token: string} | {status: 401|429, error: string}} the new phone token (48 hex
   *   characters, 192 bits) with unlimited lifetime and all capabilities.
   */
  const redeem = (code) => {
    const now = Date.now();
    // Drop failures that have aged out of the rate-limit window.
    while (fails.length && fails[0] <= now - FAIL_WINDOW_MS) fails.shift();
    if (fails.length >= MAX_FAILS) return { status: 429, error: 'too many attempts' };
    const exp = typeof code === 'string' ? codes.get(code) : undefined;
    // Unknown or expired code counts as a failure (an expired one is also deleted).
    if (exp === undefined || exp <= now) {
      if (exp !== undefined) codes.delete(code);
      fails.push(now);
      return { status: 401, error: 'invalid or used code' };
    }
    // Burn the code: it can never be redeemed twice.
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
  /**
   * @param {object} [options]
   * @param {string} [options.agentId='agent'] - agent the token is bound to (also in its prefix).
   * @param {string} [options.role='worker']
   * @param {number} [options.ttlMs] - lifetime; default one hour.
   * @param {string[]} [options.capabilities] - default hook:permission and hook:event.
   * @returns {{token: string, expiresAt: number, agentId: string}} the plaintext token, which is
   *   not recoverable later.
   */
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

  // Look up a presented token and return its metadata, or null. Expired tokens are removed on sight.
  /**
   * @param {string} given - presented token.
   * @returns {object|null} stored scope {expiresAt, agentId, role, capabilities}, or null if
   *   unknown, empty or expired.
   */
  const getSession = (given) => {
    if (!given) return null;
    const now = Date.now();
    const d = digest(given);
    for (const [hash, meta] of tokens.entries()) {
      // Constant-time comparison against every stored digest, so timing does not leak how much of a token matched.
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

  // Boolean form of getSession, used by the /api gate in server.mjs.
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

  return { newCode, redeem, valid, issueAgentToken, getSession, revoke };
}

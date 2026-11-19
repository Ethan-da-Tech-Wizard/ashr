// File: test/agent-tokens.test.mjs
// Purpose: Tests for per-agent session tokens: issuing, scoping by capability and agent,
// expiry and revocation, in the auth store and through the running hub (node:test, no network).
//
// How it fits: covers the second auth layer (scoped agent tokens) of hub/auth.mjs and the
// verifyAgentToken checks in hub/routes.mjs. Two unit tests use createAuth() directly; the third
// starts a hub on a free port. Tokens are never real secrets here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../hub/auth.mjs';
import { startHub } from '../hub/server.mjs';

// Scenario: issue two tokens for different agents. They must be distinct, carry the agent name in their
// prefix, be valid, expose agentId/role through getSession, and revoking one must not affect the other.
// An unknown token is invalid.
test('ephemeral per-agent tokens are isolated and scoped', () => {
  const auth = createAuth();
  const t1 = auth.issueAgentToken({ agentId: 'claude-agent', role: 'worker' });
  const t2 = auth.issueAgentToken({ agentId: 'gemini-arch', role: 'worker' });

  assert.ok(t1.token.startsWith('ashr_claude-agent_'));
  assert.ok(t2.token.startsWith('ashr_gemini-arch_'));
  assert.notEqual(t1.token, t2.token);

  assert.equal(auth.valid(t1.token), true);
  assert.equal(auth.valid(t2.token), true);
  assert.equal(auth.valid('invalid_token'), false);

  const s1 = auth.getSession(t1.token);
  assert.equal(s1.agentId, 'claude-agent');
  assert.equal(s1.role, 'worker');

  // Revocation
  assert.equal(auth.revoke(t1.token), true);
  assert.equal(auth.valid(t1.token), false);
  assert.equal(auth.valid(t2.token), true);
});

// Scenario: a token with ttlMs 25 is valid immediately and invalid after 40 ms. Why: expiry is checked
// lazily when a token is presented, so this proves the check happens on use (no background timer).
test('ephemeral per-agent tokens expire after TTL', async () => {
  const auth = createAuth();
  const { token } = auth.issueAgentToken({ agentId: 'quick-agent', ttlMs: 25 });
  assert.equal(auth.valid(token), true);

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(auth.valid(token), false);
});

// Scenario, end to end in six steps: (1) issue a token over HTTP; (2) a permission call with it succeeds
// (Read is low risk -> allow); (3) a garbage token gets 401; (4) a token that lacks hook:permission gets 403
// on /hook/permission; (5) revoke via the revoke endpoint; (6) the revoked token now gets 401. The hub is
// closed in `finally` so a failing assertion cannot leave a server running.
test('hub endpoints: /hook/agent-token issues, validates, and revokes tokens', async () => {
  const hub = await startHub({ port: 0, host: '127.0.0.1', holdMs: 300 });
  const base = `http://127.0.0.1:${hub.port}`;

  try {
    // 1. Issue an ephemeral token
    const issueRes = await fetch(`${base}/hook/agent-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'gemini',
        role: 'worker',
        ttlMs: 60000,
        capabilities: ['hook:permission', 'hook:event'],
      }),
    });
    assert.equal(issueRes.status, 200);
    const issued = await issueRes.json();
    assert.equal(issued.ok, true);
    assert.ok(issued.token.startsWith('ashr_gemini_'));
    assert.equal(issued.agentId, 'gemini');

    // 2. Call /hook/permission with valid token
    const permRes = await fetch(`${base}/hook/permission`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${issued.token}`,
      },
      body: JSON.stringify({
        session_id: 'test-sess',
        agent: 'gemini',
        tool_name: 'Read',
        tool_input: { file_path: '/repo/test.txt' },
      }),
    });
    assert.equal(permRes.status, 200);
    const permData = await permRes.json();
    assert.equal(permData.hookSpecificOutput?.decision?.behavior, 'allow');

    // 3. Call /hook/permission with invalid token -> 401
    const invalidRes = await fetch(`${base}/hook/permission`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ashr_invalid_garbage',
      },
      body: JSON.stringify({
        session_id: 'test-sess',
        agent: 'gemini',
        tool_name: 'Read',
      }),
    });
    assert.equal(invalidRes.status, 401);

    // 4. Issue a token missing 'hook:permission' capability
    const limitedRes = await fetch(`${base}/hook/agent-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'gemini',
        capabilities: ['hook:event'], // missing hook:permission
      }),
    });
    const limited = await limitedRes.json();
    const forbiddenRes = await fetch(`${base}/hook/permission`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${limited.token}`,
      },
      body: JSON.stringify({
        session_id: 'test-sess',
        agent: 'gemini',
        tool_name: 'Read',
      }),
    });
    assert.equal(forbiddenRes.status, 403);

    // 5. Revoke the token via /hook/agent-token/revoke
    const revokeRes = await fetch(`${base}/hook/agent-token/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: issued.token }),
    });
    assert.equal(revokeRes.status, 200);
    const revokeData = await revokeRes.json();
    assert.equal(revokeData.ok, true);
    assert.equal(revokeData.revoked, true);

    // 6. Calling again with revoked token -> 401
    const postRevokeRes = await fetch(`${base}/hook/permission`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${issued.token}`,
      },
      body: JSON.stringify({
        session_id: 'test-sess',
        agent: 'gemini',
        tool_name: 'Read',
      }),
    });
    assert.equal(postRevokeRes.status, 401);
  } finally {
    await hub.close();
  }
});

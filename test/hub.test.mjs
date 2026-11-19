// File: test/hub.test.mjs
// Purpose: End-to-end tests of the hub: start a real server on an ephemeral port and exercise
// permission hooks, auto-approval of low-risk calls, holding and deciding asks, and state snapshots.
//
// How it fits: these are the main integration tests for hub/server.mjs + routes.mjs + state.mjs together,
// using real HTTP (no mocks) against a hub on a random free port bound to loopback. holdMs is 400 so the
// timeout test finishes quickly instead of waiting the production 110 s. Run: npm test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHub } from '../hub/server.mjs';

// hub = running hub handle, base = its http://127.0.0.1:<port> URL; both set in before().
let hub, base;// Fixed admin token (ASHR_TOKEN equivalent) so tests do not need the pairing flow.
const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
// Helper: POST JSON to the test hub, authenticated by default.
const post = (path, body, headers = auth) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
// Builds a Claude-style PermissionRequest body. session_id 'abc123def' maps to session id 'claude-abc123'.
const perm = (tool_name, tool_input) => ({
  hook_event_name: 'PermissionRequest', session_id: 'abc123def', cwd: '/repo/wt', tool_name, tool_input,
});

// Start one hub for the whole file; close() in after() ends SSE clients and sockets so node:test can exit.
before(async () => {
  hub = await startHub({ port: 0, token: TOKEN, host: '127.0.0.1', holdMs: 400 });
  base = `http://127.0.0.1:${hub.port}`;
});
after(() => hub.close());

// Pins the auth gate: /api/* without a token is 401, and the ?t= query form (used by EventSource,
// which cannot send headers) is accepted.
test('api requires the token', async () => {
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await fetch(base + `/api/state?t=${TOKEN}`)).status, 200);
});

// Scenario: reading a file inside the project is low risk. The hub must answer `allow` immediately
// (no phone involved), leave no pending ask and log it with verdict 'auto'. Why: this is the product's
// core promise, that safe actions never interrupt the user.
test('low risk permission is allowed at once and logged as auto', async () => {
  const res = await post('/hook/permission', perm('Read', { file_path: '/repo/wt/a.ts' }));
  const body = await res.json();
  assert.equal(body.hookSpecificOutput.decision.behavior, 'allow');
  const state = await (await fetch(base + '/api/state', { headers: auth })).json();
  assert.equal(state.log[0].verdict, 'auto');
  assert.equal(state.asks.length, 0);
});

// Scenario: `rm -rf` is HIGH, so the request is parked. The test polls /api/state until the ask appears,
// checks it is high risk and the session is `needs_you`, then denies it with a message. The still-open
// hook request must then resolve to a deny that contains that message, the session returns to `working`
// and the log records 'deny'. Why: covers the whole hold -> decide -> release round trip.
test('high risk is held until the phone denies', async () => {
  const pending = post('/hook/permission', perm('Bash', { command: 'rm -rf /repo/wt/dist' })).then((r) => r.json());
  let ask;
  for (let i = 0; i < 50 && !ask; i++) {
    await new Promise((r) => setTimeout(r, 20));
    ask = (await (await fetch(base + '/api/state', { headers: auth })).json()).asks[0];
  }
  assert.ok(ask, 'ask appeared');
  assert.equal(ask.risk, 'high');
  const mid = await (await fetch(base + '/api/state', { headers: auth })).json();
  assert.equal(mid.sessions[0].state, 'needs_you');
  const d = await post('/api/decide', { askId: ask.id, behavior: 'deny', message: 'too risky' });
  assert.equal(d.status, 200);
  const body = await pending;
  assert.equal(body.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(body.hookSpecificOutput.decision.message, /too risky/);
  const after = await (await fetch(base + '/api/state', { headers: auth })).json();
  assert.equal(after.sessions[0].state, 'working');
  assert.equal(after.log[0].verdict, 'deny');
});

// Scenario: nobody answers a medium-risk request. After holdMs (400 ms) the hub must deny with the
// fixed message and log 'timeout'. Why: an agent must never wait forever or be allowed by default.
test('unanswered request times out with a deny', async () => {
  const body = await (await post('/hook/permission', perm('Bash', { command: 'npm install left-pad' }))).json();
  assert.equal(body.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(body.hookSpecificOutput.decision.message, 'No answer from phone in time');
  const state = await (await fetch(base + '/api/state', { headers: auth })).json();
  assert.equal(state.log[0].verdict, 'timeout');
});

// Scenario: error paths of the phone endpoints. Unknown ask id -> 410 (expired), unknown session -> 404,
// empty text -> 400. Why: the phone must be able to tell 'too late' from 'bad request'.
test('decide validates input', async () => {
  assert.equal((await post('/api/decide', { askId: 'nope', behavior: 'allow' })).status, 410);
  assert.equal((await post('/api/say', { sessionId: 'nope', text: 'hi' })).status, 404);
  assert.equal((await post('/api/say', { sessionId: 'x', text: '' })).status, 400);
});

// Scenario: a /hook request carrying X-Forwarded-For (as a tunnel adds) must be refused with 403 even
// though the socket is loopback. Why: otherwise anyone reaching the public tunnel URL could call hooks.
test('hooks reject proxied requests', async () => {
  const res = await post('/hook/event', {}, { 'Content-Type': 'application/json', 'X-Forwarded-For': '1.2.3.4' });
  assert.equal(res.status, 403);
});

// Scenario: the body's `agent` and `title` create a session labelled for that agent (grok here), not
// the default claude. Why: Gemini, Codex and Grok share the same endpoint via these fields.
test('hookPermission supports custom agent and title (gemini, codex, grok)', async () => {
  const custom = {
    ...perm('Read', { file_path: '/repo/wt/b.ts' }),
    agent: 'grok',
    title: 'grok-task',
    session_id: 'grok-session-77',
  };
  const res = await post('/hook/permission', custom);
  assert.equal(res.status, 200);
  const state = await (await fetch(base + '/api/state', { headers: auth })).json();
  const grokSess = state.sessions.find((s) => s.agent === 'grok');
  assert.ok(grokSess, 'grok session was created');
  assert.equal(grokSess.agent, 'grok');
  assert.equal(grokSess.title, 'grok-task');
});

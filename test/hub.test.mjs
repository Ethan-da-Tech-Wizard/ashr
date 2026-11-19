// File: test/hub.test.mjs
// Purpose: End-to-end tests of the hub: start a real server on an ephemeral port and exercise
// permission hooks, auto-approval of low-risk calls, holding and deciding asks, and state snapshots.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHub } from '../hub/server.mjs';

let hub, base;
const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
// Helper: POST JSON to the test hub, authenticated by default.
const post = (path, body, headers = auth) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
const perm = (tool_name, tool_input) => ({
  hook_event_name: 'PermissionRequest', session_id: 'abc123def', cwd: '/repo/wt', tool_name, tool_input,
});

before(async () => {
  hub = await startHub({ port: 0, token: TOKEN, host: '127.0.0.1', holdMs: 400 });
  base = `http://127.0.0.1:${hub.port}`;
});
after(() => hub.close());

test('api requires the token', async () => {
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await fetch(base + `/api/state?t=${TOKEN}`)).status, 200);
});

test('low risk permission is allowed at once and logged as auto', async () => {
  const res = await post('/hook/permission', perm('Read', { file_path: '/repo/wt/a.ts' }));
  const body = await res.json();
  assert.equal(body.hookSpecificOutput.decision.behavior, 'allow');
  const state = await (await fetch(base + '/api/state', { headers: auth })).json();
  assert.equal(state.log[0].verdict, 'auto');
  assert.equal(state.asks.length, 0);
});

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

test('unanswered request times out with a deny', async () => {
  const body = await (await post('/hook/permission', perm('Bash', { command: 'npm install left-pad' }))).json();
  assert.equal(body.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(body.hookSpecificOutput.decision.message, 'No answer from phone in time');
  const state = await (await fetch(base + '/api/state', { headers: auth })).json();
  assert.equal(state.log[0].verdict, 'timeout');
});

test('decide validates input', async () => {
  assert.equal((await post('/api/decide', { askId: 'nope', behavior: 'allow' })).status, 410);
  assert.equal((await post('/api/say', { sessionId: 'nope', text: 'hi' })).status, 404);
  assert.equal((await post('/api/say', { sessionId: 'x', text: '' })).status, 400);
});

test('hooks reject proxied requests', async () => {
  const res = await post('/hook/event', {}, { 'Content-Type': 'application/json', 'X-Forwarded-For': '1.2.3.4' });
  assert.equal(res.status, 403);
});

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

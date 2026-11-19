// File: test/hub-auth.test.mjs
// Purpose: Tests for hub authentication: pairing codes, token checks on /api, and localhost-only /hook routes.
//
// How it fits: complements test/hub.test.mjs (which uses a fixed token) by exercising the REAL pairing
// flow of hub/auth.mjs through HTTP. No fixed token is configured, so only paired tokens work. holdMs is
// 3 s so the 20 held requests in the last test stay open long enough to be inspected.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHub } from '../hub/server.mjs';

let hub, base;
// Header every hook POST needs (the hub rejects other content types with 415).
const JSON_H = { 'Content-Type': 'application/json' };
const post = (path, body, headers = JSON_H) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
// Bash permission body; a distinct sid gives each request its own session so asks do not merge.
const perm = (cmd, sid = 'q1') => ({ hook_event_name: 'PermissionRequest', session_id: sid, cwd: '/repo/wt', tool_name: 'Bash', tool_input: { command: cmd } });

before(async () => {
  hub = await startHub({ port: 0, host: '127.0.0.1', holdMs: 3000 });
  base = `http://127.0.0.1:${hub.port}`;
});
after(() => hub.close());

// Scenario: get a code from the localhost endpoint, redeem it for a token, use the token as Bearer header
// and as ?t=, then try the same code again. The second redeem must fail (401, or 410) and a made-up token
// must be 401. Why: one-time codes are what make a photographed QR useless.
test('pair code works once, then the session token opens /api/state', async () => {
  const { url } = await (await post('/hook/pair-code', {})).json();
  const code = new URL(url).searchParams.get('pair');
  assert.ok(code);
  assert.equal((await fetch(base + '/api/state')).status, 401);
  const ok = await post('/api/pair', { code });
  assert.equal(ok.status, 200);
  const { token } = await ok.json();
  assert.equal((await fetch(base + '/api/state', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await fetch(base + `/api/state?t=${token}`)).status, 200);
  const again = await post('/api/pair', { code });
  assert.ok([401, 410].includes(again.status));
  assert.equal((await fetch(base + '/api/state', { headers: { Authorization: 'Bearer nope' } })).status, 401);
});

// Scenario: two phones pair independently; their tokens differ and both work. Why: pairing one device
// must not invalidate or reuse another's token.
test('several sessions can pair, each with its own token', async () => {
  const tokens = [];
  for (let i = 0; i < 2; i++) {
    const { url } = await (await post('/hook/pair-code', {})).json();
    tokens.push((await (await post('/api/pair', { code: new URL(url).searchParams.get('pair') })).json()).token);
  }
  assert.notEqual(tokens[0], tokens[1]);
  for (const t of tokens) assert.equal((await fetch(base + `/api/state?t=${t}`)).status, 200);
});

// Scenario: a hook POST with text/plain or no content type gets 415. Why: browsers can send those cross-site
// without a CORS preflight, so requiring JSON closes a CSRF hole.
test('hooks need application/json', async () => {
  const res = await fetch(base + '/hook/event', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(res.status, 415);
  assert.equal((await fetch(base + '/hook/event', { method: 'POST', body: '{}' })).status, 415);
});

// Scenario: open 20 held asks (rm -rf each), then a 21st must be denied at once with 'ashr queue full'
// (fail closed under load). Next, decide one ask, then decide it again: the repeat gets 410 {error:'expired'}.
// Finally the remaining asks are denied and awaited so no request is left hanging when the hub closes.
test('queue full denies, stale decide gets 410', async () => {
  const { url } = await (await post('/hook/pair-code', {})).json();
  const { token } = await (await post('/api/pair', { code: new URL(url).searchParams.get('pair') })).json();
  const auth = { ...JSON_H, Authorization: `Bearer ${token}` };
  const held = [];
  for (let i = 0; i < 20; i++) held.push(post('/hook/permission', perm(`rm -rf /repo/wt/d${i}`, `s${i}`)).then((r) => r.json()));
  for (let i = 0; i < 100; i++) {
    const st = await (await fetch(base + '/api/state', { headers: auth })).json();
    if (st.asks.length === 20) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const full = await (await post('/hook/permission', perm('rm -rf /repo/wt/extra', 'extra'))).json();
  assert.equal(full.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(full.hookSpecificOutput.decision.message, 'ashr queue full');
  const st = await (await fetch(base + '/api/state', { headers: auth })).json();
  const id = st.asks[0].id;
  assert.equal((await post('/api/decide', { askId: id, behavior: 'allow' }, auth)).status, 200);
  const stale = await post('/api/decide', { askId: id, behavior: 'allow' }, auth);
  assert.equal(stale.status, 410);
  assert.deepEqual(await stale.json(), { error: 'expired' });
  for (const a of st.asks.slice(1)) await post('/api/decide', { askId: a.id, behavior: 'deny' }, auth);
  await Promise.all(held);
});

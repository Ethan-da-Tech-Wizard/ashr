// File: test/fuzz.test.mjs
// Purpose: Fuzz and abuse tests that throw malformed, oversized and hostile input at the running hub's
// HTTP endpoints. The hub must answer with a clean 4xx and must never crash or hang.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startHub } from '../hub/server.mjs';

let hub, base;
const TOKEN = 'fuzz-test-token-xyz';
const authHeaders = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};
const hookHeaders = {
  'Content-Type': 'application/json',
};

// Raw HTTP helper to send arbitrary strings, chunked streams, or raw buffers
function rawRequest({ method = 'POST', path = '/', headers = {}, body = null }) {
  return new Promise((resolve) => {
    const req = http.request(
      base + path,
      {
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            // keep raw
          }
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      }
    );
    req.on('error', (err) => resolve({ error: err, status: 0 }));

    if (body !== null) {
      if (typeof body === 'string' || Buffer.isBuffer(body)) {
        req.write(body);
      } else {
        req.write(JSON.stringify(body));
      }
    }
    req.end();
  });
}

const post = (path, body, headers = authHeaders) =>
  fetch(base + path, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

before(async () => {
  // Use a short holdMs (500ms) for fast timeout tests
  hub = await startHub({ port: 0, token: TOKEN, host: '127.0.0.1', holdMs: 500 });
  base = `http://127.0.0.1:${hub.port}`;
});

after(async () => {
  if (hub) await hub.close();
});

describe('1. Malformed JSON handling', () => {
  const malformedBodies = [
    '{ not valid json }',
    '{"tool_name": "Bash", "incomplete": ',
    '{"key": "\x00\x01\x02"}', // raw control bytes unescaped in JSON
    '<<<XML><payload>test</payload></XML>',
    'undefined',
    'NaN',
    '{"trailing": "comma",}',
    '{"nested": {"unclosed": 123}',
  ];

  const endpoints = [
    { path: '/hook/permission', headers: hookHeaders },
    { path: '/hook/event', headers: hookHeaders },
    { path: '/hook/fake', headers: hookHeaders },
    { path: '/api/decide', headers: authHeaders },
    { path: '/api/say', headers: authHeaders },
    { path: '/api/kill', headers: authHeaders },
    { path: '/api/explain', headers: authHeaders },
    { path: '/api/pair', headers: { 'Content-Type': 'application/json' } },
  ];

  for (const ep of endpoints) {
    test(`Endpoint ${ep.path} rejects malformed JSON with 400`, async () => {
      for (const badBody of malformedBodies) {
        const res = await rawRequest({
          method: 'POST',
          path: ep.path,
          headers: ep.headers,
          body: badBody,
        });
        assert.equal(res.status, 400, `Expected 400 for ${badBody} on ${ep.path}`);
        assert.ok(res.json?.error, 'Error message should be returned');
      }
    });
  }

  test('Hub remains responsive after malformed JSON fuzzing', async () => {
    const res = await fetch(base + '/api/state', { headers: authHeaders });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.sessions));
  });
});

describe('2. Huge request payloads (> 1MB / body bomb)', () => {
  test('Payload slightly under 1MB is accepted', async () => {
    // 800 KB valid JSON
    const pad = 'x'.repeat(800_000);
    const res = await post(
      '/hook/event',
      {
        hook_event_name: 'SessionStart',
        agent: 'claude',
        session_id: 'large-ok',
        cwd: '/repo',
        prompt: pad,
      },
      hookHeaders
    );
    assert.equal(res.status, 200);
  });

  test('Payload exceeding 1MB is rejected with 400 or connection termination', async () => {
    // 1.5MB body
    const bigPad = 'y'.repeat(1_500_000);
    const res = await rawRequest({
      method: 'POST',
      path: '/hook/permission',
      headers: hookHeaders,
      body: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: bigPad },
      }),
    });
    // server rejects with 400 'body too large' or destroys socket
    assert.ok(
      res.status === 400 || res.error || res.status === 0,
      `Expected 400 or destroyed socket, got status: ${res.status}`
    );
    if (res.json) {
      assert.match(res.json.error, /body too large/i);
    }
  });

  test('Chunked streaming body bomb exceeding 1MB', async () => {
    const res = await new Promise((resolve) => {
      const req = http.request(base + '/hook/event', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        },
      }, (r) => {
        let data = '';
        r.on('data', (d) => { data += d; });
        r.on('end', () => resolve({ status: r.statusCode, data }));
      });

      req.on('error', (err) => resolve({ error: err, status: 0 }));

      // Stream 20 chunks of 64KB = 1.28MB
      const chunk = Buffer.alloc(64 * 1024, 'a');
      for (let i = 0; i < 20; i++) {
        req.write(chunk);
      }
      req.end();
    });

    assert.ok(res.status === 400 || res.error || res.status === 0);
  });

  test('Hub remains fully functional after payload flood', async () => {
    const res = await fetch(base + '/api/state', { headers: authHeaders });
    assert.equal(res.status, 200);
  });
});

describe('3. Concurrent rapid calls and queue limits', () => {
  test('Concurrent rapid calls to /hook/permission correctly enforce MAX_OPEN_ASKS limit', async () => {
    // MAX_OPEN_ASKS is 20. Launch 28 concurrent high-risk permission requests.
    const promises = [];
    for (let i = 0; i < 28; i++) {
      promises.push(
        post(
          '/hook/permission',
          {
            hook_event_name: 'PermissionRequest',
            agent: 'claude',
            session_id: `burst-${i}`,
            cwd: '/repo',
            tool_name: 'Bash',
            tool_input: { command: `rm -rf /dist/${i}` },
          },
          hookHeaders
        ).then((r) => r.json())
      );
    }

    // Wait for requests to process or settle
    const results = await Promise.all(promises);

    // Some should be denied due to "ashr queue full" (when queue >= 20)
    const queueFulls = results.filter(
      (r) => r?.hookSpecificOutput?.decision?.message === 'ashr queue full'
    );
    assert.ok(queueFulls.length >= 8, `Expected at least 8 requests rejected with queue full, got ${queueFulls.length}`);

    // Clean up remaining asks by allowing them
    const stateRes = await (await fetch(base + '/api/state', { headers: authHeaders })).json();
    for (const ask of stateRes.asks) {
      await post('/api/decide', { askId: ask.id, behavior: 'allow' }, authHeaders);
    }
  });

  test('Concurrent rapid /api/decide calls on the same askId handle races gracefully', async () => {
    // Create a held ask via hook/fake for precise control
    await post(
      '/hook/fake',
      {
        session: { agent: 'claude', id: 'race-session' },
        ask: { tool: 'Bash', summary: 'npm install left-pad', risk: 'high' },
      },
      hookHeaders
    );

    const s = await (await fetch(base + '/api/state', { headers: authHeaders })).json();
    const ask = s.asks.find((a) => a.sessionId === 'race-session');
    assert.ok(ask, 'Ask should be present in state');
    const askId = ask.id;

    // Fire 10 concurrent decide calls targeting the exact same askId
    const decideCalls = await Promise.all([
      post('/api/decide', { askId, behavior: 'allow' }, authHeaders),
      post('/api/decide', { askId, behavior: 'deny', message: 'too late' }, authHeaders),
      post('/api/decide', { askId, behavior: 'allow' }, authHeaders),
      post('/api/decide', { askId, behavior: 'deny' }, authHeaders),
      post('/api/decide', { askId, behavior: 'allow' }, authHeaders),
      post('/api/decide', { askId, behavior: 'allow' }, authHeaders),
      post('/api/decide', { askId, behavior: 'deny' }, authHeaders),
      post('/api/decide', { askId, behavior: 'allow' }, authHeaders),
      post('/api/decide', { askId, behavior: 'deny' }, authHeaders),
      post('/api/decide', { askId, behavior: 'allow' }, authHeaders),
    ]);

    const statuses = decideCalls.map((r) => r.status);
    // Exactly one should succeed with 200, all other 9 should be 410 (expired)
    const successCount = statuses.filter((s) => s === 200).length;
    const expiredCount = statuses.filter((s) => s === 410).length;

    assert.equal(successCount, 1, 'Exactly one decide call must succeed');
    assert.equal(expiredCount, 9, 'All subsequent/conflicting decide calls must return 410');
  });
});

describe('4. Stale ask decisions, invalid sessionIds, and parameter edge cases', () => {
  test('/api/decide rejects stale / non-existent askId with 410', async () => {
    const res = await post('/api/decide', { askId: 'ask_nonexistent_1234', behavior: 'allow' }, authHeaders);
    assert.equal(res.status, 410);
    const body = await res.json();
    assert.equal(body.error, 'expired');
  });

  test('/api/decide rejects missing or invalid askId with 400', async () => {
    const cases = [
      {},
      { askId: '' },
      { askId: null },
      { askId: 12345 },
      { askId: ['array'] },
      { askId: 'x'.repeat(65) }, // over max 64 chars
    ];

    for (const c of cases) {
      const res = await post('/api/decide', { ...c, behavior: 'allow' }, authHeaders);
      assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(c)}`);
      const body = await res.json();
      assert.equal(body.error, 'askId required');
    }
  });

  test('/api/decide rejects invalid behavior parameter', async () => {
    // Create an ask first
    await post(
      '/hook/fake',
      {
        session: { agent: 'claude', id: 'fake-decide-val' },
        ask: { tool: 'Bash', summary: 'test invalid behavior', risk: 'high' },
      },
      hookHeaders
    );

    const s = await (await fetch(base + '/api/state', { headers: authHeaders })).json();
    const ask = s.asks.find((a) => a.sessionId === 'fake-decide-val');
    assert.ok(ask);

    const badBehaviors = ['ALLOW', 'DENY', 'maybe', 'drop', '', null, 123, true, {}];
    for (const b of badBehaviors) {
      const res = await post('/api/decide', { askId: ask.id, behavior: b }, authHeaders);
      assert.equal(res.status, 400, `Expected 400 for behavior: ${b}`);
      const body = await res.json();
      assert.match(body.error, /behavior must be allow\|deny/);
    }

    // Clean up
    await post('/api/decide', { askId: ask.id, behavior: 'allow' }, authHeaders);
  });

  test('/api/say and /api/kill reject invalid or non-existent sessionIds', async () => {
    // Non-existent session
    const sayNone = await post('/api/say', { sessionId: 'ghost-session', text: 'hello' }, authHeaders);
    assert.equal(sayNone.status, 404);
    assert.equal((await sayNone.json()).error, 'unknown sessionId');

    const killNone = await post('/api/kill', { sessionId: 'ghost-session' }, authHeaders);
    assert.equal(killNone.status, 404);
    assert.equal((await killNone.json()).error, 'unknown sessionId');

    // Existing session without tmux pane
    await post('/hook/fake', { session: { agent: 'codex', id: 'no-tmux-sess' } }, hookHeaders);

    const sayNoTmux = await post('/api/say', { sessionId: 'no-tmux-sess', text: 'hello' }, authHeaders);
    assert.equal(sayNoTmux.status, 409);
    assert.equal((await sayNoTmux.json()).error, 'session has no tmux pane');

    const killNoTmux = await post('/api/kill', { sessionId: 'no-tmux-sess' }, authHeaders);
    assert.equal(killNoTmux.status, 409);
    assert.equal((await killNoTmux.json()).error, 'session has no tmux pane');
  });

  test('/api/say validates text parameter', async () => {
    const cases = [
      { text: '' },
      { text: '   ' },
      { text: null },
      { text: 1234 },
      { text: 'a'.repeat(2001) }, // over 2000 limit
    ];
    for (const c of cases) {
      const res = await post('/api/say', { sessionId: 'dummy', ...c }, authHeaders);
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /text required/);
    }
  });

  test('/api/explain validates provider and ask existence', async () => {
    // Missing askId
    const resNoId = await post('/api/explain', { provider: 'gemini' }, authHeaders);
    assert.equal(resNoId.status, 400);

    // Invalid provider
    const resBadProv = await post('/api/explain', { askId: 'some-id', provider: 'chatgpt' }, authHeaders);
    assert.equal(resBadProv.status, 400);
    assert.match((await resBadProv.json()).error, /provider must be gemini\|grok/);

    // Non-existent ask without fallback summary returns 410
    const resMissing = await post('/api/explain', { askId: 'nonexistent-ask', provider: 'gemini' }, authHeaders);
    assert.equal(resMissing.status, 410);

    // Non-existent ask WITH fallback summary returns simulated breakdown
    const resFallback = await post(
      '/api/explain',
      { askId: 'expired-with-summary', summary: 'rm -rf /dist', provider: 'gemini' },
      authHeaders
    );
    assert.equal(resFallback.status, 200);
    const bodyFallback = await resFallback.json();
    assert.equal(bodyFallback.ok, true);
    assert.equal(bodyFallback.provider, 'gemini');
    assert.match(bodyFallback.explanation, /deletes directories/i);
  });
});

describe('5. Prototype pollution & missing fields fuzzing', () => {
  test('Requests containing prototype pollution keys (__proto__, constructor) do not pollute Object prototype', async () => {
    // Verify clean baseline
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(({}).admin, undefined);

    const pollutionPayloads = [
      {
        __proto__: { polluted: 'yes', admin: true },
        session: { agent: 'claude', id: '__proto__' },
      },
      {
        constructor: { prototype: { polluted: 'constructor_polluted' } },
        agent: '__proto__',
        session_id: 'proto-session',
      },
      {
        askId: '__proto__',
        behavior: 'allow',
        __proto__: { isAdmin: true },
      },
      {
        tool_name: 'Bash',
        tool_input: {
          command: 'ls',
          __proto__: { evil: true },
          constructor: { evil: true },
        },
      },
    ];

    for (const payload of pollutionPayloads) {
      await post('/hook/permission', payload, hookHeaders);
      await post('/hook/fake', payload, hookHeaders);
      await post('/api/decide', payload, authHeaders);
    }

    // Assert prototype integrity
    assert.equal(({}).polluted, undefined, 'Object prototype must not be polluted');
    assert.equal(Object.prototype.polluted, undefined, 'Object.prototype must not be polluted');
    assert.equal(({}).admin, undefined, 'admin property must not be polluted');
    assert.equal(({}).evil, undefined, 'evil property must not be polluted');
  });

  test('All POST endpoints safely handle completely empty bodies {}', async () => {
    const endpoints = [
      { path: '/hook/permission', headers: hookHeaders, expectedStatus: 200 }, // Defaults to low-risk auto
      { path: '/hook/event', headers: hookHeaders, expectedStatus: 200 },
      { path: '/hook/fake', headers: hookHeaders, expectedStatus: 400 }, // Missing session.agent
      { path: '/api/decide', headers: authHeaders, expectedStatus: 400 },
      { path: '/api/say', headers: authHeaders, expectedStatus: 400 },
      { path: '/api/kill', headers: authHeaders, expectedStatus: 404 },
      { path: '/api/explain', headers: authHeaders, expectedStatus: 400 },
      { path: '/api/pair', headers: { 'Content-Type': 'application/json' }, expectedStatus: 401 },
    ];

    for (const ep of endpoints) {
      const res = await post(ep.path, {}, ep.headers);
      assert.equal(
        res.status,
        ep.expectedStatus,
        `Endpoint ${ep.path} failed with empty object body: got ${res.status}`
      );
    }
  });

  test('JSON arrays and primitive values are safely converted without throwing unhandled exceptions', async () => {
    const nonObjectPayloads = ['[]', '[1, 2, 3]', 'null', 'true', 'false', '12345', '"plain string"'];

    for (const raw of nonObjectPayloads) {
      const res = await rawRequest({
        method: 'POST',
        path: '/hook/permission',
        headers: hookHeaders,
        body: raw,
      });
      // readJson normalizes arrays and primitives to {}, so hookPermission runs and returns 200
      assert.equal(res.status, 200);
      assert.ok(res.json?.hookSpecificOutput);
    }
  });

  test('Fields with wrong types (numbers, booleans, objects where strings expected)', async () => {
    const payload = {
      hook_event_name: { evil: true },
      session_id: 12345,
      agent: ['claude'],
      cwd: { nested: 'path' },
      tool_name: 99999,
      tool_input: 'not-an-object',
      prompt: [1, 2, 3],
      notification_type: 0,
    };

    const resPerm = await post('/hook/permission', payload, hookHeaders);
    assert.equal(resPerm.status, 200);

    const resEvent = await post('/hook/event', payload, hookHeaders);
    assert.equal(resEvent.status, 200);

    const resFake = await post('/hook/fake', { session: payload, ask: payload }, hookHeaders);
    assert.equal(resFake.status, 400); // agent wasn't a valid string in Set
  });
});

describe('6. Unicode, null bytes, control characters, and injection attacks', () => {
  test('Null bytes and control characters in command text, session_id, and titles', async () => {
    // Send a low risk tool call with null bytes and control characters so it resolves immediately
    const sneakyPayload = {
      hook_event_name: 'PermissionRequest',
      agent: 'claude',
      session_id: 'session\x00with\x00nulls',
      cwd: '/repo',
      title: 'Title\x00With\r\nInjected\x1b[31mControlChars',
      tool_name: 'Read',
      tool_input: {
        file_path: '/repo/test.txt',
      },
    };

    const res = await post('/hook/permission', sneakyPayload, hookHeaders);
    assert.equal(res.status, 200);

    // Verify session ID sanitization (non-word characters stripped, max 6)
    // 'session\x00with\x00nulls' -> 'sessionwithnulls' -> 'sessio'
    const state = await (await fetch(base + '/api/state', { headers: authHeaders })).json();
    const sess = state.sessions.find((s) => s.id === 'claude-sessio');
    assert.ok(sess, 'Session with sanitized ID was created');
    assert.equal(sess.id, 'claude-sessio');
  });

  test('Unicode RTL overrides, zero-width characters, and multibyte emoji payloads', async () => {
    const unicodePayload = {
      hook_event_name: 'UserPromptSubmit',
      agent: 'claude',
      session_id: 'unicode-agent-01',
      cwd: '/path/to/тест/🚀/目录',
      prompt: '\u202E\u200B\u200C🔥🚨 Crash Testing 💣 — 𝒳𝒴𝒵\uFEFF',
    };

    const res = await post('/hook/event', unicodePayload, hookHeaders);
    assert.equal(res.status, 200);

    const state = await (await fetch(base + '/api/state', { headers: authHeaders })).json();
    const sess = state.sessions.find((s) => s.id.startsWith('claude-unicod'));
    assert.ok(sess);
    assert.ok(sess.title.includes('Crash Testing'));
  });

  test('Path traversal attempts in static file server', async () => {
    const maliciousPaths = [
      '/../package.json',
      '/....//package.json',
      '/..%2f..%2fpackage.json',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/etc/passwd',
      '/..\\package.json',
    ];

    for (const p of maliciousPaths) {
      const res = await fetch(base + p);
      // Must be 403 Forbidden or 404 Not Found, never 200
      assert.ok(
        res.status === 403 || res.status === 404,
        `Path ${p} returned unexpected status: ${res.status}`
      );
    }
  });

  test('Malformed URI percent-encoding does not crash the server', async () => {
    const malformedUris = [
      '/%c0%af',
      '/%ZZ',
      '/%E0%A0%7E',
      '/%u0000',
    ];

    for (const p of malformedUris) {
      const res = await fetch(base + p);
      // Should be handled gracefully without crashing the process
      assert.ok(res.status >= 400);
    }

    // Verify hub is still alive
    const healthy = await fetch(base + '/api/state', { headers: authHeaders });
    assert.equal(healthy.status, 200);
  });
});

describe('7. SSE stream stability and client disconnects', () => {
  test('SSE stream handles abrupt client aborts during active state emits', async () => {
    // Open 5 SSE clients and abruptly destroy their sockets
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => {
        const req = http.get(base + `/api/stream?t=${TOKEN}`, (res) => {
          assert.equal(res.statusCode, 200);
          assert.match(res.headers['content-type'], /text\/event-stream/);
          // Destroy client abruptly
          req.destroy();
          resolve();
        });
      });
    }

    // Trigger state changes to fire ctx.state.emit() while clients are disconnected
    for (let i = 0; i < 10; i++) {
      await post(
        '/hook/event',
        {
          hook_event_name: 'UserPromptSubmit',
          agent: 'codex',
          session_id: `sse-flood-${i}`,
          prompt: `event ${i}`,
        },
        hookHeaders
      );
    }

    // Ensure server is still healthy
    const check = await fetch(base + '/api/state', { headers: authHeaders });
    assert.equal(check.status, 200);
  });

  test('Held permission request cleans up and does not hang when client drops connection', async () => {
    // Start a held permission request
    const controller = new AbortController();
    const fetchProm = fetch(base + '/hook/permission', {
      method: 'POST',
      headers: hookHeaders,
      body: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /test/held/disconnect' },
      }),
      signal: controller.signal,
    }).catch(() => {});

    // Wait until ask is recorded in state
    let askId = null;
    for (let i = 0; i < 20 && !askId; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const s = await (await fetch(base + '/api/state', { headers: authHeaders })).json();
      const match = s.asks.find((a) => a.summary?.includes('disconnect'));
      if (match) askId = match.id;
    }
    assert.ok(askId, 'Ask was held in state');

    // Abruptly abort client request
    controller.abort();
    await fetchProm;

    // Wait a brief moment for res.on('close') to cancelAsk
    await new Promise((r) => setTimeout(r, 50));

    // Verify ask was removed and cancelled
    const after = await (await fetch(base + '/api/state', { headers: authHeaders })).json();
    const remaining = after.asks.find((a) => a.id === askId);
    assert.equal(remaining, undefined, 'Cancelled ask must be purged from state.asks');
  });
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { requestAiExplanation, simulateExplanation } from '../hub/ai-explain.mjs';
import { startHub } from '../hub/server.mjs';

test('Gemini request formatting with mock fetch', async () => {
  let capturedUrl = null;
  let capturedOptions = null;

  const mockFetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: 'Gemini analysis: cat .env exposes secrets.' }],
            },
          },
        ],
      }),
    };
  };

  const ask = {
    tool: 'Bash',
    summary: 'cat .env',
    detail: 'cat .env',
    risk: 'high',
    reasons: ['reads secrets file'],
  };

  const res = await requestAiExplanation({
    ask,
    provider: 'gemini',
    fetchFn: mockFetch,
    keys: { gemini: 'fake-gemini-key', grok: null },
  });

  assert.equal(res.simulated, false);
  assert.equal(res.provider, 'gemini');
  assert.equal(res.explanation, 'Gemini analysis: cat .env exposes secrets.');

  assert.ok(capturedUrl.includes('models/gemini-2.5-flash:generateContent'));
  assert.ok(capturedUrl.includes('key=fake-gemini-key'));
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.headers['Content-Type'], 'application/json');

  const payload = JSON.parse(capturedOptions.body);
  const promptText = payload.contents[0].parts[0].text;
  assert.match(promptText, /cat \.env/);
  assert.match(promptText, /high/);
});

test('Grok request formatting with mock fetch', async () => {
  let capturedUrl = null;
  let capturedOptions = null;

  const mockFetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: 'Grok breakdown: rm -rf permanently removes target directory.',
            },
          },
        ],
      }),
    };
  };

  const ask = {
    tool: 'Bash',
    summary: 'rm -rf node_modules',
    risk: 'high',
    reasons: ['deletes directory recursively'],
  };

  const res = await requestAiExplanation({
    ask,
    provider: 'grok',
    fetchFn: mockFetch,
    keys: { gemini: null, grok: 'fake-grok-key' },
  });

  assert.equal(res.simulated, false);
  assert.equal(res.provider, 'grok');
  assert.equal(res.explanation, 'Grok breakdown: rm -rf permanently removes target directory.');

  assert.equal(capturedUrl, 'https://api.x.ai/v1/chat/completions');
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.headers['Authorization'], 'Bearer fake-grok-key');
  assert.equal(capturedOptions.headers['Content-Type'], 'application/json');

  const payload = JSON.parse(capturedOptions.body);
  assert.equal(payload.model, 'grok-2-latest');
  assert.match(payload.messages[1].content, /rm -rf node_modules/);
});

test('Fallback when no key is set or offline/error', async () => {
  const ask = { tool: 'Bash', summary: 'cat .env', risk: 'high' };

  // 1. Missing keys fallback
  const noKeyGemini = await requestAiExplanation({
    ask,
    provider: 'gemini',
    keys: { gemini: null, grok: null },
  });
  assert.equal(noKeyGemini.simulated, true);
  assert.equal(noKeyGemini.provider, 'gemini');
  assert.match(noKeyGemini.explanation, /secret environment variables/i);

  const noKeyGrok = await requestAiExplanation({
    ask,
    provider: 'grok',
    keys: { gemini: null, grok: null },
  });
  assert.equal(noKeyGrok.simulated, true);
  assert.equal(noKeyGrok.provider, 'grok');
  assert.match(noKeyGrok.explanation, /secret environment variables/i);

  // 2. Fetch throws network error
  const failingFetch = async () => {
    throw new Error('Network connection refused');
  };
  const netError = await requestAiExplanation({
    ask,
    provider: 'gemini',
    fetchFn: failingFetch,
    keys: { gemini: 'fake-key', grok: null },
  });
  assert.equal(netError.simulated, true);
  assert.equal(netError.provider, 'gemini');
  assert.ok(netError.explanation.length > 10);

  // 3. API returns HTTP 500
  const serverErrorFetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: 'internal' }),
  });
  const http500 = await requestAiExplanation({
    ask,
    provider: 'grok',
    fetchFn: serverErrorFetch,
    keys: { gemini: null, grok: 'fake-key' },
  });
  assert.equal(http500.simulated, true);
  assert.equal(http500.provider, 'grok');
});

test('simulateExplanation provides specialized descriptions for key actions', () => {
  assert.match(simulateExplanation({ summary: 'rm -rf build' }), /permanently deletes/i);
  assert.match(simulateExplanation({ summary: 'npm install framer-motion' }), /downloads and installs/i);
  assert.match(simulateExplanation({ summary: 'git push origin main' }), /publishes local repository/i);
  assert.match(simulateExplanation({ summary: 'cat .env' }), /secret environment/i);
});

// Route tests
let hub, base;
const TOKEN = 'test-ai-token';
const authHeaders = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const post = (path, body, headers = authHeaders) =>
  fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });

before(async () => {
  hub = await startHub({ port: 0, token: TOKEN, host: '127.0.0.1', holdMs: 2000 });
  base = `http://127.0.0.1:${hub.port}`;
});
after(() => hub.close());

test('route POST /api/explain requires authorization token', async () => {
  const unauth = await post('/api/explain', { askId: 'any', provider: 'gemini' }, { 'Content-Type': 'application/json' });
  assert.equal(unauth.status, 401);
});

test('route POST /api/explain validates inputs', async () => {
  // Missing askId
  const noAskId = await post('/api/explain', { provider: 'gemini' });
  assert.equal(noAskId.status, 400);
  assert.equal((await noAskId.json()).error, 'askId required');

  // Invalid provider
  const badProv = await post('/api/explain', { askId: 'ask_1', provider: 'copilot' });
  assert.equal(badProv.status, 400);
  assert.equal((await badProv.json()).error, 'provider must be gemini|grok');

  // Non-existent askId without summary
  const notFound = await post('/api/explain', { askId: 'unknown_ask', provider: 'gemini' });
  assert.equal(notFound.status, 410);
  assert.equal((await notFound.json()).error, 'expired');
});

test('route POST /api/explain handles active asks successfully', async () => {
  const ask = hub.ctx.state.addAsk({
    tool: 'Bash',
    summary: 'rm -rf dist',
    risk: 'high',
    reasons: ['deletes directory'],
  });

  // Gemini explain
  const geminiRes = await post('/api/explain', { askId: ask.id, provider: 'gemini' });
  assert.equal(geminiRes.status, 200);
  const geminiBody = await geminiRes.json();
  assert.equal(geminiBody.ok, true);
  assert.equal(geminiBody.provider, 'gemini');
  assert.equal(typeof geminiBody.explanation, 'string');
  assert.ok(geminiBody.explanation.length > 0);

  // Grok explain
  const grokRes = await post('/api/explain', { askId: ask.id, provider: 'grok' });
  assert.equal(grokRes.status, 200);
  const grokBody = await grokRes.json();
  assert.equal(grokBody.ok, true);
  assert.equal(grokBody.provider, 'grok');
  assert.equal(typeof grokBody.explanation, 'string');
  assert.ok(grokBody.explanation.length > 0);
});

test('route POST /api/explain handles fallback with ask summary in body', async () => {
  const res = await post('/api/explain', {
    askId: 'ask_adhoc',
    provider: 'gemini',
    summary: 'cat .env',
    tool: 'Bash',
    risk: 'high',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.provider, 'gemini');
  assert.match(body.explanation, /secret environment variables/i);
});

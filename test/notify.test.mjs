import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyAsk } from '../hub/notify.mjs';

test('notifyAsk ignores calls without a topic', async () => {
  const ok = await notifyAsk({ risk: 'high', summary: 'rm -rf' }, '');
  assert.equal(ok, false);
});

test('notifyAsk ignores low risk asks', async () => {
  const ok = await notifyAsk({ risk: 'low', summary: 'cat file' }, 'my-test-topic');
  assert.equal(ok, false);
});

test('notifyAsk posts medium risk asks to ntfy with default priority', async () => {
  let calledUrl, calledOpts;
  const mockFetch = async (url, opts) => {
    calledUrl = url;
    calledOpts = opts;
    return { ok: true };
  };

  const ask = { risk: 'medium', tool: 'Bash', summary: 'npm install lodash', reasons: ['network install'] };
  const ok = await notifyAsk(ask, 'test-topic-123', mockFetch);

  assert.equal(ok, true);
  assert.equal(calledUrl, 'https://ntfy.sh/test-topic-123');
  assert.equal(calledOpts.method, 'POST');
  assert.equal(calledOpts.headers.Priority, 'default');
  assert.equal(calledOpts.headers.Tags, 'bell');
  assert.match(calledOpts.headers.Title, /MEDIUM risk/);
  assert.match(calledOpts.body, /npm install lodash/);
  assert.match(calledOpts.body, /network install/);
});

test('notifyAsk posts high risk asks to ntfy with high priority and warning tag', async () => {
  let calledUrl, calledOpts;
  const mockFetch = async (url, opts) => {
    calledUrl = url;
    calledOpts = opts;
    return { ok: true };
  };

  const ask = { risk: 'high', tool: 'Bash', summary: 'rm -rf /', reasons: ['dangerous command', 'system path'] };
  const ok = await notifyAsk(ask, 'alert-topic', mockFetch);

  assert.equal(ok, true);
  assert.equal(calledUrl, 'https://ntfy.sh/alert-topic');
  assert.equal(calledOpts.headers.Priority, 'high');
  assert.equal(calledOpts.headers.Tags, 'warning');
  assert.match(calledOpts.headers.Title, /HIGH risk/);
});

test('notifyAsk handles network fetch errors without throwing', async () => {
  const failingFetch = async () => {
    throw new Error('network down');
  };
  const ask = { risk: 'high', tool: 'Bash', summary: 'rm -rf /', reasons: [] };
  const ok = await notifyAsk(ask, 'alert-topic', failingFetch);
  assert.equal(ok, false);
});

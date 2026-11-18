import test from 'node:test';
import assert from 'node:assert/strict';
import { loadKeys, saveKey } from '../hub/keys.mjs';

test('loadKeys returns an object with expected provider keys', () => {
  const keys = loadKeys();
  assert.ok(keys && typeof keys === 'object');
  assert.ok('gemini' in keys);
  assert.ok('grok' in keys);
  assert.ok('openai' in keys);
  assert.ok('anthropic' in keys);
});

test('saveKey rejects invalid key names containing dangerous characters or empty string', () => {
  const invalidNames = ['', null, undefined, 123, 'KEY=VALUE', 'KEY\nNAME', 'my key', '123_bad'];
  for (const name of invalidNames) {
    assert.throws(() => saveKey(name, 'test-val'), /invalid key name/);
  }
});

test('saveKey accepts valid identifier names', () => {
  // Uses a safe dummy key name that won't disrupt real credentials
  assert.doesNotThrow(() => saveKey('TEST_ASHR_DUMMY_KEY', 'abc-123\nnewline'));
  const keys = loadKeys();
  assert.ok(keys);
});

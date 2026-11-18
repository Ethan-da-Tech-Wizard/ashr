// Program: ashr - keys.test.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Tests the key loader and saver in hub/keys.mjs: the loaded shape and rejection or acceptance of key names.
// Test tools and the key functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadKeys, saveKey } from '../hub/keys.mjs';

// The result has an entry for each provider.
test('loadKeys returns an object with expected provider keys', () => {
  const keys = loadKeys();
  assert.ok(keys && typeof keys === 'object');
  assert.ok('gemini' in keys);
  assert.ok('grok' in keys);
  assert.ok('openai' in keys);
  assert.ok('anthropic' in keys);
});

// Bad key names such as empty text, = signs, line breaks or spaces must throw "invalid key name".
test('saveKey rejects invalid key names containing dangerous characters or empty string', () => {
  const invalidNames = ['', null, undefined, 123, 'KEY=VALUE', 'KEY\nNAME', 'my key', '123_bad'];
  for (const name of invalidNames) {
    assert.throws(() => saveKey(name, 'test-val'), /invalid key name/);
  }
});

// A valid name is accepted. Note this test calls the real saveKey, so it writes to the key file in the home folder.
test('saveKey accepts valid identifier names', () => {
  // Uses a safe dummy key name that won't disrupt real credentials
  assert.doesNotThrow(() => saveKey('TEST_ASHR_DUMMY_KEY', 'abc-123\nnewline'));
  const keys = loadKeys();
  assert.ok(keys);
});

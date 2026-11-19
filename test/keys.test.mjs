// File: test/keys.test.mjs
// Purpose: Tests for the API key loader (hub/keys.mjs): shape of loadKeys() and saveKey() validation.
//
// How it fits: tests hub/keys.mjs. CAUTION: these tests use the REAL home directory. The last test calls
// saveKey('TEST_ASHR_DUMMY_KEY', ...), which creates/updates ~/.config/ashr/keys.env on the machine running
// the suite (the dummy line is harmless but is left there).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadKeys, saveKey } from '../hub/keys.mjs';

// Shape check: loadKeys() returns an object with one entry per supported provider, whatever is configured.
test('loadKeys returns an object with expected provider keys', () => {
  const keys = loadKeys();
  assert.ok(keys && typeof keys === 'object');
  assert.ok('gemini' in keys);
  assert.ok('grok' in keys);
  assert.ok('openai' in keys);
  assert.ok('anthropic' in keys);
});

// Injection guard: names that are empty, non-strings, contain '=' or a newline, contain spaces or start with a
// digit must be refused, because a name is written into a NAME=value file.
test('saveKey rejects invalid key names containing dangerous characters or empty string', () => {
  const invalidNames = ['', null, undefined, 123, 'KEY=VALUE', 'KEY\nNAME', 'my key', '123_bad'];
  for (const name of invalidNames) {
    assert.throws(() => saveKey(name, 'test-val'), /invalid key name/);
  }
});

// A valid name with a value containing a newline is accepted (the newline is stripped, see saveKey) and
// loading afterwards still works. The dummy key name avoids clobbering real credentials.
test('saveKey accepts valid identifier names', () => {
  // Uses a safe dummy key name that won't disrupt real credentials
  assert.doesNotThrow(() => saveKey('TEST_ASHR_DUMMY_KEY', 'abc-123\nnewline'));
  const keys = loadKeys();
  assert.ok(keys);
});

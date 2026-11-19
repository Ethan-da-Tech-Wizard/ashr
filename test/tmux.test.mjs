// File: test/tmux.test.mjs
// Purpose: Tests for tmux target validation and for rejecting bad targets before tmux is ever invoked.
//
// How it fits: tests hub/tmux.mjs, the only code that turns phone input into a process call. tmux itself is
// never started by these tests because every case is rejected (or accepted) before execFile runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validTarget, typeInto, interrupt } from '../hub/tmux.mjs';

// Accepts pane ids (%0, %12) and session:window[.pane] names; rejects empty, non-string values and anything
// with shell metacharacters (; | backticks, spaces).
test('validTarget validates standard tmux pane and window identifiers', () => {
  assert.equal(validTarget('%0'), true);
  assert.equal(validTarget('%12'), true);
  assert.equal(validTarget('ashr:1'), true);
  assert.equal(validTarget('session-name:win.0'), true);

  assert.equal(validTarget(''), false);
  assert.equal(validTarget(null), false);
  assert.equal(validTarget(123), false);
  assert.equal(validTarget('bad;target'), false);
  assert.equal(validTarget('ashr:1 | sh'), false);
  assert.equal(validTarget('`rm -rf /`'), false);
});

// Both entry points throw 'invalid tmux target' for bad input; reaching tmux would have been the bug.
test('typeInto and interrupt reject invalid targets without invoking tmux', async () => {
  await assert.rejects(() => typeInto('bad;target', 'ls'), /invalid tmux target/);
  await assert.rejects(() => typeInto(null, 'ls'), /invalid tmux target/);
  await assert.rejects(() => interrupt('bad;target'), /invalid tmux target/);
  await assert.rejects(() => interrupt(''), /invalid tmux target/);
});

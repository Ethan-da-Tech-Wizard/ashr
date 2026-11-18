// Program: ashr - tmux.test.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Tests hub/tmux.mjs: the target name check and that bad targets are refused before tmux is run.
// Test tools and the tmux helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validTarget, typeInto, interrupt } from '../hub/tmux.mjs';

// Good pane and window names pass; empty, wrong-type and shell-injection strings fail.
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

// Invalid targets must be rejected without starting tmux.
test('typeInto and interrupt reject invalid targets without invoking tmux', async () => {
  await assert.rejects(() => typeInto('bad;target', 'ls'), /invalid tmux target/);
  await assert.rejects(() => typeInto(null, 'ls'), /invalid tmux target/);
  await assert.rejects(() => interrupt('bad;target'), /invalid tmux target/);
  await assert.rejects(() => interrupt(''), /invalid tmux target/);
});

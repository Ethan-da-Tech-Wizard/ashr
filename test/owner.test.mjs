// Program: ashr - owner.test.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Tests how the hub finds the owner name (environment, gh, git, computer user), rejects invalid names and gives new sessions that owner.
// Test tools and the owner and state code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOwner, validOwner } from '../hub/owner.mjs';
import { createState } from '../hub/state.mjs';

// A fake command runner that always fails, like a missing program.
const none = () => { throw new Error('not installed'); };

// The ASHR_OWNER setting beats every other source.
test('ASHR_OWNER wins over everything', () => {
  assert.equal(resolveOwner({ env: { ASHR_OWNER: 'zazmattaz-debug' }, run: () => 'someone-else', user: () => 'mac' }), 'zazmattaz-debug');
});

// Order of fallbacks: gh, then git, then the computer user.
test('falls back to the gh user, then git, then the laptop user', () => {
  const gh = (cmd) => (cmd === 'gh' ? 'Ethan-da-Tech-Wizard\n' : '');
  assert.equal(resolveOwner({ env: {}, run: gh, user: () => 'mac' }), 'Ethan-da-Tech-Wizard');
  const git = (cmd) => { if (cmd === 'gh') throw new Error('no gh'); return 'octo\n'; };
  assert.equal(resolveOwner({ env: {}, run: git, user: () => 'mac' }), 'octo');
  assert.equal(resolveOwner({ env: {}, run: none, user: () => 'mac' }), 'mac');
});

// Invalid names are rejected, giving "unknown" when nothing valid is left.
test('rejects names that are not GitHub logins', () => {
  assert.equal(validOwner('<img src=x>'), null);
  assert.equal(validOwner('-bad'), null);
  assert.equal(validOwner('a'.repeat(40)), null);
  assert.equal(resolveOwner({ env: { ASHR_OWNER: 'bad name' }, run: none, user: () => 'not valid!' }), 'unknown');
});

// New sessions get the hub's owner, and a patch can override it.
test('new sessions carry the hub owner and a patch can override it', () => {
  const state = createState({ owner: 'zazmattaz-debug' });
  assert.equal(state.upsertSession('claude-1', {}).owner, 'zazmattaz-debug');
  assert.equal(state.upsertSession('codex-1', { owner: 'Ethan-da-Tech-Wizard' }).owner, 'Ethan-da-Tech-Wizard');
});

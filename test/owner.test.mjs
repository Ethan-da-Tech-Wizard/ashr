// File: test/owner.test.mjs
// Purpose: Tests for resolving the hub owner's GitHub name (env, gh, git, OS user) and for how
// new sessions inherit it.
//
// How it fits: tests hub/owner.mjs and the owner default in hub/state.mjs. The command runner and OS user
// lookup are injected, so no real gh, git or account is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOwner, validOwner } from '../hub/owner.mjs';
import { createState } from '../hub/state.mjs';

// Stand-in for a missing command: throws like execFileSync does when the program is not installed.
const none = () => { throw new Error('not installed'); };

// Precedence: an explicit ASHR_OWNER beats gh, git and the OS user.
test('ASHR_OWNER wins over everything', () => {
  assert.equal(resolveOwner({ env: { ASHR_OWNER: 'zazmattaz-debug' }, run: () => 'someone-else', user: () => 'mac' }), 'zazmattaz-debug');
});

// Fallback chain, in order: gh answers; gh fails and git answers; both fail and the OS user is used.
test('falls back to the gh user, then git, then the laptop user', () => {
  const gh = (cmd) => (cmd === 'gh' ? 'Ethan-da-Tech-Wizard\n' : '');
  assert.equal(resolveOwner({ env: {}, run: gh, user: () => 'mac' }), 'Ethan-da-Tech-Wizard');
  const git = (cmd) => { if (cmd === 'gh') throw new Error('no gh'); return 'octo\n'; };
  assert.equal(resolveOwner({ env: {}, run: git, user: () => 'mac' }), 'octo');
  assert.equal(resolveOwner({ env: {}, run: none, user: () => 'mac' }), 'mac');
});

// Validation: markup, a leading hyphen and a 40-character name are refused, and when every source is invalid
// the result is 'unknown' (never an unsafe string).
test('rejects names that are not GitHub logins', () => {
  assert.equal(validOwner('<img src=x>'), null);
  assert.equal(validOwner('-bad'), null);
  assert.equal(validOwner('a'.repeat(40)), null);
  assert.equal(resolveOwner({ env: { ASHR_OWNER: 'bad name' }, run: none, user: () => 'not valid!' }), 'unknown');
});

// New sessions get the hub's owner by default; a patch (for example from /hook/fake) can set another owner.
test('new sessions carry the hub owner and a patch can override it', () => {
  const state = createState({ owner: 'zazmattaz-debug' });
  assert.equal(state.upsertSession('claude-1', {}).owner, 'zazmattaz-debug');
  assert.equal(state.upsertSession('codex-1', { owner: 'Ethan-da-Tech-Wizard' }).owner, 'Ethan-da-Tech-Wizard');
});

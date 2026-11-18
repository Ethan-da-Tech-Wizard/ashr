import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOwner, validOwner } from '../hub/owner.mjs';
import { createState } from '../hub/state.mjs';

const none = () => { throw new Error('not installed'); };

test('ASHR_OWNER wins over everything', () => {
  assert.equal(resolveOwner({ env: { ASHR_OWNER: 'zazmattaz-debug' }, run: () => 'someone-else', user: () => 'mac' }), 'zazmattaz-debug');
});

test('falls back to the gh user, then git, then the laptop user', () => {
  const gh = (cmd) => (cmd === 'gh' ? 'Ethan-da-Tech-Wizard\n' : '');
  assert.equal(resolveOwner({ env: {}, run: gh, user: () => 'mac' }), 'Ethan-da-Tech-Wizard');
  const git = (cmd) => { if (cmd === 'gh') throw new Error('no gh'); return 'octo\n'; };
  assert.equal(resolveOwner({ env: {}, run: git, user: () => 'mac' }), 'octo');
  assert.equal(resolveOwner({ env: {}, run: none, user: () => 'mac' }), 'mac');
});

test('rejects names that are not GitHub logins', () => {
  assert.equal(validOwner('<img src=x>'), null);
  assert.equal(validOwner('-bad'), null);
  assert.equal(validOwner('a'.repeat(40)), null);
  assert.equal(resolveOwner({ env: { ASHR_OWNER: 'bad name' }, run: none, user: () => 'not valid!' }), 'unknown');
});

test('new sessions carry the hub owner and a patch can override it', () => {
  const state = createState({ owner: 'zazmattaz-debug' });
  assert.equal(state.upsertSession('claude-1', {}).owner, 'zazmattaz-debug');
  assert.equal(state.upsertSession('codex-1', { owner: 'Ethan-da-Tech-Wizard' }).owner, 'Ethan-da-Tech-Wizard');
});

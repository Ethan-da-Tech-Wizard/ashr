// File: test/explain.test.mjs
// Purpose: Tests for the plain-English request explainer used on approval cards (headlines and points).
import test from 'node:test';
import assert from 'node:assert/strict';
import { explain } from '../app/explain.js';

const head = (tool, summary, extra = {}) => explain({ tool, summary, risk: 'medium', ...extra }).headline;

test('secret files are called out in plain words', () => {
  assert.match(head('Bash', 'cat .env'), /secrets file \(\.env\).*passwords and keys/);
});

test('installs, pushes and deletes read as plain sentences', () => {
  assert.equal(head('Bash', 'npm install framer-motion'), 'Download and install framer-motion from the internet.');
  assert.equal(head('Bash', 'git push origin main'), 'Upload this code to GitHub on the "main" branch. Your team will see it.');
  assert.match(head('Bash', 'rm -rf build'), /^Delete build\. Deleted files do not come back\.$/);
});

test('chained commands become one sentence with "then"', () => {
  assert.equal(
    head('Bash', 'rm -rf node_modules && npm install'),
    'Delete node_modules, then download and install every package this project lists.',
  );
});

test('redirects are ignored and unknown commands still get a sentence', () => {
  assert.equal(head('Bash', 'npm test 2>/dev/null'), "Run the project's tests.");
  assert.match(head('Bash', 'frobnicate --all'), /^Run "frobnicate --all" in the terminal\.$/);
});

test('file tools name the file', () => {
  assert.equal(head('Edit', 'Edit src/components/Nav.tsx'), 'Change the file src/components/Nav.tsx.');
  assert.equal(head('Write', 'Write notes.md'), 'Create or replace the file notes.md.');
});

test('points give the reason, the risk and what each choice does', () => {
  const { points } = explain({ tool: 'Bash', summary: 'cat .env', risk: 'high', reasons: ['may expose secrets'] }, 'claude');
  assert.deepEqual(points, [
    'Flagged because: may expose secrets.',
    'This could leak secrets or lose work.',
    'Allow and claude does it now. Deny and it stops and waits.',
  ]);
});

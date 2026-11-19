// File: test/explain.test.mjs
// Purpose: Tests for the plain-English request explainer used on approval cards (headlines and points).
//
// How it fits: tests app/explain.js, the offline sentence generator behind each card's headline. The text
// is user-facing, so these tests pin exact wording for the most common commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { explain } from '../app/explain.js';

// Helper: headline for a medium-risk ask with the given tool and summary.
const head = (tool, summary, extra = {}) => explain({ tool, summary, risk: 'medium', ...extra }).headline;

// Reading a .env file must be described as opening a secrets file holding passwords and keys.
test('secret files are called out in plain words', () => {
  assert.match(head('Bash', 'cat .env'), /secrets file \(\.env\).*passwords and keys/);
});

// The three most common risky actions: install (names the package), git push (names the branch and says
// the team will see it), delete (warns it is permanent).
test('installs, pushes and deletes read as plain sentences', () => {
  assert.equal(head('Bash', 'npm install framer-motion'), 'Download and install framer-motion from the internet.');
  assert.equal(head('Bash', 'git push origin main'), 'Upload this code to GitHub on the "main" branch. Your team will see it.');
  assert.match(head('Bash', 'rm -rf build'), /^Delete build\. Deleted files do not come back\.$/);
});

// `a && b` becomes 'A, then b' (first letter of later steps lower-cased), so a chain reads as one sentence.
test('chained commands become one sentence with "then"', () => {
  assert.equal(
    head('Bash', 'rm -rf node_modules && npm install'),
    'Delete node_modules, then download and install every package this project lists.',
  );
});

// Output redirections (2>/dev/null) must not change the description, and an unrecognised program still
// gets a generic quoted sentence instead of an empty headline.
test('redirects are ignored and unknown commands still get a sentence', () => {
  assert.equal(head('Bash', 'npm test 2>/dev/null'), "Run the project's tests.");
  assert.match(head('Bash', 'frobnicate --all'), /^Run "frobnicate --all" in the terminal\.$/);
});

// Edit and Write asks name the file in plain words.
test('file tools name the file', () => {
  assert.equal(head('Edit', 'Edit src/components/Nav.tsx'), 'Change the file src/components/Nav.tsx.');
  assert.equal(head('Write', 'Write notes.md'), 'Create or replace the file notes.md.');
});

// The bullet list has exactly three entries in this order: the guard's reasons, a risk sentence, and what
// Allow and Deny do (using the agent's name).
test('points give the reason, the risk and what each choice does', () => {
  const { points } = explain({ tool: 'Bash', summary: 'cat .env', risk: 'high', reasons: ['may expose secrets'] }, 'claude');
  assert.deepEqual(points, [
    'Flagged because: may expose secrets.',
    'This could leak secrets or lose work.',
    'Allow and claude does it now. Deny and it stops and waits.',
  ]);
});

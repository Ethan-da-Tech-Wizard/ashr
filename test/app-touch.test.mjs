import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../app/styles.css', import.meta.url), 'utf8');

// A sideways swipe on a phone is cancelled by the browser unless every part of the card,
// including the scrolling panel inside it, leaves sideways movement to the page.
test('every part of a card lets the app handle sideways swipes', () => {
  assert.match(css, /\.card\s*\{[^}]*touch-action:\s*pan-y/);
  assert.match(css, /\.card \*\s*\{[^}]*touch-action:\s*pan-y/);
});

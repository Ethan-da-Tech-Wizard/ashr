// Program: ashr - app-touch.test.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Tests that the app's CSS lets the browser leave sideways swipes to the app on every part of a card.
// Test tools and file reading.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Read the app's stylesheet as text.
const css = readFileSync(new URL('../app/styles.css', import.meta.url), 'utf8');

// A sideways swipe on a phone is cancelled by the browser unless every part of the card,
// including the scrolling panel inside it, leaves sideways movement to the page.
test('every part of a card lets the app handle sideways swipes', () => {
  assert.match(css, /\.card\s*\{[^}]*touch-action:\s*pan-y/);
  assert.match(css, /\.card \*\s*\{[^}]*touch-action:\s*pan-y/);
});

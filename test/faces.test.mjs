// Program: ashr - faces.test.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Tests the decision faces and the character drawing: words, thumbs, tile colours, fallbacks and the head shape chosen per owner.
// Test tools and the face and character functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { faceSvg, faceWord } from '../app/faces.js';
import { STYLES, styleFor, characterSvg } from '../app/character.js';

// Each decision has its own character and word.
test('each decision has its own character and word', () => {
  assert.equal(faceWord('allow'), 'allowed');
  assert.equal(faceWord('deny'), 'denied');
  assert.equal(faceWord('neutral'), 'redirected');
  const [a, d, n] = ['allow', 'deny', 'neutral'].map((k) => faceSvg(k));
  assert.notEqual(a, d);
  assert.notEqual(d, n);
});

// Allow has a thumb up, deny a thumb down, neutral has neither.
test('allow has a thumb up, deny a thumb down, neutral has neither', () => {
  assert.match(faceSvg('allow'), /class="thumb up"/);
  assert.match(faceSvg('deny'), /class="thumb down"/);
  assert.doesNotMatch(faceSvg('neutral'), /class="thumb/);
});

// Each decision sits on its own coloured tile.
test('every decision sits on its own coloured tile', () => {
  for (const k of ['allow', 'deny', 'neutral']) {
    assert.match(faceSvg(k), new RegExp(`id="tile-${k}"`));
    assert.match(faceSvg(k), new RegExp(`fill="url\\(#tile-${k}\\)"`));
  }
});

// An unknown kind falls back to the neutral look.
test('an unknown kind falls back to the neutral character', () => {
  assert.equal(faceSvg('mystery'), faceSvg('neutral'));
  assert.equal(faceWord('mystery'), 'redirected');
});

// The face uses the owner's head shape.
test('the decision face wears the owner\'s head shape', () => {
  assert.notEqual(faceSvg('allow', 'rays'), faceSvg('allow', 'fin'));
});

// An owner always gets the same head shape, and two different owners get different shapes.
test('an owner always gets the same head shape, and the two of us get different ones', () => {
  assert.equal(styleFor('zazmattaz-debug'), styleFor('ZAZMATTAZ-debug'));
  assert.ok(STYLES.includes(styleFor('zazmattaz-debug')));
  assert.notEqual(styleFor('zazmattaz-debug'), styleFor('Ethan-da-Tech-Wizard'));
});

// All head shapes share one body and differ only on top.
test('all head shapes share one body and differ only on top', () => {
  const marks = STYLES.map((s) => characterSvg(s));
  assert.equal(new Set(marks).size, STYLES.length);
  for (const m of marks) assert.match(m, /<ellipse cx="32" cy="40" rx="18" ry="15.5"/);
  assert.equal(characterSvg('no-such-style'), characterSvg('rays'));
});

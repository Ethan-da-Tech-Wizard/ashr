// File: test/faces.test.mjs
// Purpose: Tests for the decision faces and owner characters: distinct output per decision, stable
// mapping from owner name to head shape.
//
// How it fits: tests app/faces.js and app/character.js, the SVG builders behind the decision animation and
// agent tiles. They compare generated markup strings, so no rendering engine is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { faceSvg, faceWord } from '../app/faces.js';
import { STYLES, styleFor, characterSvg } from '../app/character.js';

// Allow, deny and neutral have distinct captions and distinct artwork.
test('each decision has its own character and word', () => {
  assert.equal(faceWord('allow'), 'allowed');
  assert.equal(faceWord('deny'), 'denied');
  assert.equal(faceWord('neutral'), 'redirected');
  const [a, d, n] = ['allow', 'deny', 'neutral'].map((k) => faceSvg(k));
  assert.notEqual(a, d);
  assert.notEqual(d, n);
});

// Allow shows a thumb up, deny a thumb down, neutral no thumb: the gesture is how the outcome is read at a glance.
test('allow has a thumb up, deny a thumb down, neutral has neither', () => {
  assert.match(faceSvg('allow'), /class="thumb up"/);
  assert.match(faceSvg('deny'), /class="thumb down"/);
  assert.doesNotMatch(faceSvg('neutral'), /class="thumb/);
});

// Each outcome defines its own gradient (id `tile-<kind>`) and fills its tile with it; unique ids stop two
// stamps on one page from sharing a gradient.
test('every decision sits on its own coloured tile', () => {
  for (const k of ['allow', 'deny', 'neutral']) {
    assert.match(faceSvg(k), new RegExp(`id="tile-${k}"`));
    assert.match(faceSvg(k), new RegExp(`fill="url\\(#tile-${k}\\)"`));
  }
});

// Unknown outcomes render as neutral/'redirected', so a new decision kind can never produce a blank stamp.
test('an unknown kind falls back to the neutral character', () => {
  assert.equal(faceSvg('mystery'), faceSvg('neutral'));
  assert.equal(faceWord('mystery'), 'redirected');
});

// The stamp uses the owner's head style, so different owners' stamps differ.
test('the decision face wears the owner\'s head shape', () => {
  assert.notEqual(faceSvg('allow', 'rays'), faceSvg('allow', 'fin'));
});

// styleFor is deterministic and case-insensitive, returns a known style, and the two team members map to
// different shapes (a regression guard on the hash).
test('an owner always gets the same head shape, and the two of us get different ones', () => {
  assert.equal(styleFor('zazmattaz-debug'), styleFor('ZAZMATTAZ-debug'));
  assert.ok(STYLES.includes(styleFor('zazmattaz-debug')));
  assert.notEqual(styleFor('zazmattaz-debug'), styleFor('Ethan-da-Tech-Wizard'));
});

// Every style produces distinct artwork but the same body ellipse; an unknown style falls back to 'rays'.
test('all head shapes share one body and differ only on top', () => {
  const marks = STYLES.map((s) => characterSvg(s));
  assert.equal(new Set(marks).size, STYLES.length);
  for (const m of marks) assert.match(m, /<ellipse cx="32" cy="40" rx="18" ry="15.5"/);
  assert.equal(characterSvg('no-such-style'), characterSvg('rays'));
});

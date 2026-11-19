// File: test/agents.test.mjs
// Purpose: Tests for the phone app's agent tile builders (owner label, photo URL, HTML escaping).
// These are pure string functions, so they run in node without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerName, ownerPhoto, agentHtml, tileHtml } from '../app/agents.js';

test('owner label is the first part of the GitHub name', () => {
  assert.equal(ownerName('zazmattaz-debug'), 'zazmattaz');
  assert.equal(ownerName('Ethan-da-Tech-Wizard'), 'Ethan');
  assert.equal(ownerName('octocat'), 'octocat');
});

test('missing, unknown or unsafe owners give no label and no photo', () => {
  for (const bad of [undefined, '', 'unknown', '"><script>', 'a b']) {
    assert.equal(ownerName(bad), '');
    assert.equal(ownerPhoto(bad), '');
  }
});

test('the photo comes from the full GitHub name', () => {
  assert.equal(ownerPhoto('Ethan-da-Tech-Wizard'), 'https://github.com/Ethan-da-Tech-Wizard.png?size=64');
});

test('a tile shows the task, the owner and the agent with its state', () => {
  const html = agentHtml({ agent: 'codex', title: 'build <nav>', owner: 'Ethan-da-Tech-Wizard' }, 'working');
  assert.match(html, /class="by">@Ethan</);
  assert.match(html, /build &lt;nav&gt;/);
  assert.match(html, /codex · working/);
  assert.doesNotMatch(agentHtml({ agent: 'codex', title: 't' }, 'idle'), /class="by"/);
});

test('one owner has one character on every agent, and the tile class carries the agent colour', () => {
  const mine = ['claude', 'codex', 'gemini', 'grok'].map((agent) => tileHtml({ agent, owner: 'zazmattaz-debug' }));
  const svgOf = (html) => html.match(/<svg[\s\S]*?<\/svg>/)[0];
  assert.equal(new Set(mine.map(svgOf)).size, 1);
  assert.match(mine[1], /class="tile codex"/);
  assert.notEqual(svgOf(mine[0]), svgOf(tileHtml({ agent: 'claude', owner: 'Ethan-da-Tech-Wizard' })));
});

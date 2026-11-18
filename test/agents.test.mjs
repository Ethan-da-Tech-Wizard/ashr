// Program: ashr - agents.test.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Tests the agent tile builders in app/agents.js: owner names, photo addresses and the tile and button HTML.
// Test tools and the functions under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerName, ownerPhoto, agentHtml, tileHtml } from '../app/agents.js';

// The label is the first part of the GitHub name.
test('owner label is the first part of the GitHub name', () => {
  assert.equal(ownerName('zazmattaz-debug'), 'zazmattaz');
  assert.equal(ownerName('Ethan-da-Tech-Wizard'), 'Ethan');
  assert.equal(ownerName('octocat'), 'octocat');
});

// Bad or missing owners give no label and no photo.
test('missing, unknown or unsafe owners give no label and no photo', () => {
  for (const bad of [undefined, '', 'unknown', '"><script>', 'a b']) {
    assert.equal(ownerName(bad), '');
    assert.equal(ownerPhoto(bad), '');
  }
});

// The photo address uses the full GitHub name.
test('the photo comes from the full GitHub name', () => {
  assert.equal(ownerPhoto('Ethan-da-Tech-Wizard'), 'https://github.com/Ethan-da-Tech-Wizard.png?size=64');
});

// The agent HTML contains the title, owner and the agent with its state.
test('a tile shows the task, the owner and the agent with its state', () => {
  const html = agentHtml({ agent: 'codex', title: 'build <nav>', owner: 'Ethan-da-Tech-Wizard' }, 'working');
  assert.match(html, /class="by">@Ethan</);
  assert.match(html, /build &lt;nav&gt;/);
  assert.match(html, /codex · working/);
  assert.doesNotMatch(agentHtml({ agent: 'codex', title: 't' }, 'idle'), /class="by"/);
});

// The same owner always gets the same character and the tile class carries the agent colour.
test('one owner has one character on every agent, and the tile class carries the agent colour', () => {
  const mine = ['claude', 'codex', 'gemini', 'grok'].map((agent) => tileHtml({ agent, owner: 'zazmattaz-debug' }));
  const svgOf = (html) => html.match(/<svg[\s\S]*?<\/svg>/)[0];
  assert.equal(new Set(mine.map(svgOf)).size, 1);
  assert.match(mine[1], /class="tile codex"/);
  assert.notEqual(svgOf(mine[0]), svgOf(tileHtml({ agent: 'claude', owner: 'Ethan-da-Tech-Wizard' })));
});

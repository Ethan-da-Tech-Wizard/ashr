// Program: ashr - card.test.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Tests cardHtml in app/card.js: content, the See change button, HTML escaping and handling of bad input.
// Test tools and the function under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cardHtml } from '../app/card.js';

// The card shows agent, owner, risk and headline.
test('cardHtml renders card with agent, owner, risk and headline', () => {
  const ask = {
    id: 'ask_1',
    tool: 'Bash',
    summary: 'cat .env',
    risk: 'high',
    reasons: ['touches env file or key'],
  };
  const session = {
    agent: 'claude',
    title: 'fix bug',
    owner: 'Ethan-da-Tech-Wizard',
  };
  const html = cardHtml(ask, session, '12s');

  assert.match(html, /class="risk high">high risk<\/span>/);
  assert.match(html, /claude · @Ethan/);
  assert.match(html, /fix bug/);
  assert.match(html, /Open your secrets file/);
  assert.match(html, /cat \.env/);
  assert.match(html, /12s/);
  assert.match(html, /waiting/);
});

// The See change button appears only when the detail differs from the summary.
test('cardHtml includes "See change" button when detail differs from summary', () => {
  const askWithDiff = {
    tool: 'Edit',
    summary: 'Edit config.js',
    detail: 'config.js\n---\n+ const x = 1;',
    risk: 'medium',
  };
  const session = { agent: 'codex', title: 'refactor' };
  const htmlWithDiff = cardHtml(askWithDiff, session, '3s');
  assert.match(htmlWithDiff, /data-act="diff"/);

  const askNoDiff = {
    tool: 'Bash',
    summary: 'npm test',
    detail: 'npm test',
    risk: 'low',
  };
  const htmlNoDiff = cardHtml(askNoDiff, session, '1s');
  assert.doesNotMatch(htmlNoDiff, /data-act="diff"/);
});

// Text containing HTML must be escaped so it cannot inject markup.
test('cardHtml escapes HTML in inputs to prevent XSS injection', () => {
  const maliciousAsk = {
    tool: 'Bash',
    summary: '<script>alert(1)</script>',
    risk: 'high',
    reasons: ['<img src=x onerror=alert(2)>'],
  };
  const maliciousSession = {
    agent: 'claude',
    title: '<b onmouseover=evil()>title</b>',
    owner: 'attacker-"><script>',
  };
  const html = cardHtml(maliciousAsk, maliciousSession, '<img onerror=x>');

  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<b onmouseover/);
  assert.doesNotMatch(html, /<img /);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;b onmouseover=evil\(\)&gt;title&lt;\/b&gt;/);
  assert.match(html, /&lt;img onerror=x&gt;/);
});

// Missing or malformed inputs must not throw.
test('cardHtml handles null, undefined and malformed inputs gracefully without throwing', () => {
  assert.doesNotThrow(() => cardHtml(null, null, null));
  assert.doesNotThrow(() => cardHtml(undefined, undefined, undefined));
  assert.doesNotThrow(() => cardHtml({}, {}, ''));
  assert.doesNotThrow(() => cardHtml({ tool: 123 }, { agent: null }, false));

  const nullHtml = cardHtml(null, null, null);
  assert.match(nullHtml, /class="risk medium">medium risk<\/span>/);
  assert.match(nullHtml, /Action needs your decision\./);
  assert.match(nullHtml, /0s/);
});

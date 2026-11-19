// File: test/card.test.mjs
// Purpose: Tests for cardHtml(): that the approval card markup includes the agent, owner, risk and
// headline, and that untrusted text is escaped.
//
// How it fits: tests app/card.js, a pure string builder, directly under Node (no browser or jsdom), by
// matching regular expressions against the returned HTML. The XSS test is the important one: ask and
// session fields are written by agents and must never become live markup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cardHtml } from '../app/card.js';

// Scenario: a high-risk `cat .env` ask from a claude session owned by Ethan. The markup must contain the
// risk badge, '<agent> · @<short owner>', the session title, the plain-English headline from explain.js,
// the exact command and the wait time label.
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

// Scenario: the 'See change' button appears only when `detail` differs from `summary` (a real diff to show)
// and is omitted when they are identical, so users are not offered an empty view.
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

// Security scenario: script tags, event-handler attributes and quote-breaking owner names are put in every
// field. None may appear unescaped in the output, and the escaped text must be present so the user can still
// see what the agent sent.
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

// Robustness scenario: null, undefined, empty and wrongly typed inputs must not throw (a malformed hub
// update should not blank the whole phone UI) and render a generic MEDIUM placeholder card with '0s' wait.
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

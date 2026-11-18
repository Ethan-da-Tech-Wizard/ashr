// Program: ashr - guard-secrets.test.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Tests secret detection: the regex fallback, how the external git-secret-shield tool is used, failure handling, and how findings change the risk score.
// Test tools, file helpers, the scanners and the scorer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSecrets, scanSecretsSync } from '../guard/secrets.mjs';
import { score } from '../guard/rules.mjs';

// Fake secrets are built at run time so scanners do not flag this test file.
// Fake Gemini-style key built at runtime. Low entropy, so only git-secret-shield flags it.
const SHIELD_ONLY = `key = "${'AIza' + 'Ab1'.repeat(11) + 'Ab'}"`;
const AWS = `k = "${'AKIA' + 'ABCDEFGHIJKLMNOP'}"`;

// Run a function with ASHR_SECRET_SHIELD set to a value, then restore the old value.
async function withShield(value, fn) {
  const prev = process.env.ASHR_SECRET_SHIELD;
  if (value === undefined) delete process.env.ASHR_SECRET_SHIELD;
  else process.env.ASHR_SECRET_SHIELD = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.ASHR_SECRET_SHIELD;
    else process.env.ASHR_SECRET_SHIELD = prev;
  }
}

// Make a fake secretshield module that exits with the given code.
// A fake shield checkout whose python module exits with the given code.
// Create the temporary folder and files for the fake tool.
function fakeShield(exitCode) {
  const root = mkdtempSync(join(tmpdir(), 'ashr-fake-shield-'));
  mkdirSync(join(root, 'secretshield'));
  writeFileSync(join(root, 'secretshield', '__init__.py'), '');
  writeFileSync(join(root, 'secretshield', '__main__.py'), `import sys\nsys.exit(${exitCode})\n`);
  return root;
}

// Without the tool, the built-in patterns still find secrets.
test('regex fallback works when the shield tool is not configured', async () => {
  await withShield(undefined, async () => {
    assert.deepEqual(await scanSecrets(AWS), ['AWS access key']);
    assert.deepEqual(await scanSecrets('echo hello'), []);
    assert.deepEqual(await scanSecrets(SHIELD_ONLY), []);
    assert.deepEqual(scanSecretsSync(AWS), ['AWS access key']);
  });
});

// A path that does not exist behaves like no tool.
test('regex fallback works when ASHR_SECRET_SHIELD points at nothing', async () => {
  await withShield('/nonexistent/git-secret-shield', async () => {
    assert.deepEqual(await scanSecrets(AWS), ['AWS access key']);
    assert.deepEqual(await scanSecrets('echo hello'), []);
  });
});

// The synchronous scan must not run the external tool.
test('scanSecretsSync never calls the external tool', async () => {
  await withShield(fakeShield(1), async () => {
    assert.deepEqual(scanSecretsSync('echo hello'), []);
  });
});

// Exit code 0 means clean and 1 means a finding.
test('configured shield: exit 0 clean, exit 1 finding', async () => {
  await withShield(fakeShield(0), async () => assert.deepEqual(await scanSecrets('echo hello'), []));
  await withShield(fakeShield(1), async () => assert.deepEqual(await scanSecrets('echo hello'), ['git-secret-shield hit']));
});

// A crash gives "secret scan failed", which scores medium.
test('configured shield with no verdict (crash exit 2) is "secret scan failed", scored medium', async () => {
  await withShield(fakeShield(2), async () => {
    assert.deepEqual(await scanSecrets('echo hello'), ['secret scan failed']);
    const r = await score({ tool: 'Write', input: { file_path: '/repo/wt/a.js', content: 'x = 1' }, cwd: '/repo/wt' });
    assert.equal(r.risk, 'medium');
    assert.ok(r.reasons.includes('secret scan failed'));
    const b = await score({ tool: 'Bash', input: { command: 'npm test' }, cwd: '/repo/wt' });
    assert.equal(b.risk, 'medium');
    assert.ok(b.reasons.includes('secret scan failed'));
  });
});

// A finding from the tool scores high.
test('shield hit scores high', async () => {
  await withShield(fakeShield(1), async () => {
    const r = await score({ tool: 'Write', input: { file_path: '/repo/wt/a.js', content: 'x = 1' }, cwd: '/repo/wt' });
    assert.equal(r.risk, 'high');
  });
});

// When the tool is configured the regex findings still come first.
test('regex still wins first when the shield tool is configured', async () => {
  await withShield('/nonexistent/git-secret-shield', async () => {
    assert.deepEqual(await scanSecrets(AWS), ['AWS access key']);
  });
});

// Optional test against the real tool, skipped unless ASHR_SECRET_SHIELD_TEST points at a checkout.
// Runs only when a checkout of git-secret-shield is at the path in ASHR_SECRET_SHIELD_TEST.
const real = process.env.ASHR_SECRET_SHIELD_TEST;
test('real git-secret-shield flags what the regexes miss', { skip: !real || !existsSync(real) }, async () => {
  await withShield(real, async () => {
    assert.deepEqual(await scanSecrets(SHIELD_ONLY), ['git-secret-shield hit']);
    assert.deepEqual(await scanSecrets('echo hello'), []);
  });
});

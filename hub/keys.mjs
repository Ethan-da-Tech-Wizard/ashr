// Secure key loader for ashr agents.
// Reads credentials from ~/.config/ashr/keys.env or environment variables.
// Never exposes key values in git, logs, or to the phone app.
// Key file format: one NAME=value per line, '#' comments allowed.
//
// How it fits: ai-explain.mjs calls loadKeys() before each AI Explain request to find a Gemini
//   or Grok key; scripts/grok-agent.mjs and the tests may call saveKey(). Keys never reach the
//   phone or git: only a presence check and the provider call itself use them.
// Precedence: real environment variables win over the file, so CI or a shell export can
//   override a stale file entry.
// Known limits: no encryption at rest (protection is file mode 0600 in a 0700 folder); the
//   parser handles only simple NAME=value lines (no `export`, no multi-line values).
// Test: test/keys.test.mjs.
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Per-user config location (XDG-style). Outside any repository, so a key file cannot be
// committed by accident.
const CONFIG_DIR = join(homedir(), '.config', 'ashr');
const KEYS_FILE = join(CONFIG_DIR, 'keys.env');

// Return the provider keys the hub knows about (null for each that is missing).
// Real environment variables take precedence over the file.
/**
 * @returns {{gemini: string|null, grok: string|null, openai: string|null, anthropic: string|null}}
 *   key per provider, or null when unset. GROK accepts XAI_API_KEY or GROK_API_KEY. Never
 *   throws: an unreadable key file is treated as empty.
 */
export function loadKeys() {
  // Copy so we can merge file values without mutating process.env.
  const env = { ...process.env };
  if (existsSync(KEYS_FILE)) {
    try {
      // Parse line by line: skip blanks and comments, split at the FIRST '=' so values may
      // contain '=' (base64 keys often end in it), and strip one pair of surrounding quotes.
      const lines = readFileSync(KEYS_FILE, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq > 0) {
          const key = trimmed.slice(0, eq).trim();
          const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
          // Only fill in names the environment has not already set.
          if (!env[key]) env[key] = val;
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  // Only the named provider keys are exposed, never the whole environment.
  return {
    gemini: env.GEMINI_API_KEY || null,
    grok: env.XAI_API_KEY || env.GROK_API_KEY || null,
    openai: env.OPENAI_API_KEY || null,
    anthropic: env.ANTHROPIC_API_KEY || null,
  };
}

// Persist NAME=value into the key file, replacing an existing line for NAME.
// The directory is created 0700 and the file 0600 so other local users cannot read it.
/**
 * @param {string} name - environment-variable style name, e.g. 'GEMINI_API_KEY'.
 * @param {string} value - secret; CR/LF are removed.
 * @returns {void}
 * @throws {Error} 'invalid key name' for any name that is not [A-Za-z_][A-Za-z0-9_]*.
 *   Side effects: creates ~/.config/ashr (0700) and rewrites keys.env (0600), keeping other lines.
 */
export function saveKey(name, value) {
  // Restrict names to environment-variable syntax so a name cannot inject extra lines.
  if (!name || typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error('invalid key name');
  }
  // Strip newlines so a value cannot smuggle in additional KEY=value lines.
  const cleanVal = String(value ?? '').replace(/[\r\n]+/g, '');
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  let content = '';
  if (existsSync(KEYS_FILE)) content = readFileSync(KEYS_FILE, 'utf8');
  // Rewrite in place: replace the existing NAME= line if there is one, otherwise append.
  const lines = content.split('\n');
  let replaced = false;
  const newLines = lines.map((line) => {
    if (line.trim().startsWith(`${name}=`)) {
      replaced = true;
      return `${name}=${cleanVal}`;
    }
    return line;
  });
  if (!replaced) newLines.push(`${name}=${cleanVal}`);
  // filter(Boolean) drops blank lines, so the saved file is compacted on every write.
  writeFileSync(KEYS_FILE, newLines.filter(Boolean).join('\n') + '\n', { mode: 0o600 });
  // Re-assert permissions in case the file already existed with looser ones.
  try { chmodSync(KEYS_FILE, 0o600); } catch {}
}

// Secure key loader for ashr agents.
// Reads credentials from ~/.config/ashr/keys.env or environment variables.
// Never exposes key values in git, logs, or to the phone app.
// Key file format: one NAME=value per line, '#' comments allowed.
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_DIR = join(homedir(), '.config', 'ashr');
const KEYS_FILE = join(CONFIG_DIR, 'keys.env');

// Return the provider keys the hub knows about (null for each that is missing).
// Real environment variables take precedence over the file.
export function loadKeys() {
  // Copy so we can merge file values without mutating process.env.
  const env = { ...process.env };
  if (existsSync(KEYS_FILE)) {
    try {
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
  writeFileSync(KEYS_FILE, newLines.filter(Boolean).join('\n') + '\n', { mode: 0o600 });
  // Re-assert permissions in case the file already existed with looser ones.
  try { chmodSync(KEYS_FILE, 0o600); } catch {}
}

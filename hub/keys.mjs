// Program: ashr - keys.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Loads and saves API keys from environment variables or ~/.config/ashr/keys.env so keys stay out of git, logs and the phone app.
// Secure key loader for ashr agents.
// Reads credentials from ~/.config/ashr/keys.env or environment variables.
// Never exposes key values in git, logs, or to the phone app.
// File, path and home-folder helpers.
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// The private config folder and the key file inside it.
const CONFIG_DIR = join(homedir(), '.config', 'ashr');
const KEYS_FILE = join(CONFIG_DIR, 'keys.env');

// Read keys: start from the environment, then add values from the key file (only for names not already set). Returns the keys for Gemini, Grok, OpenAI and Anthropic, or null if absent.
export function loadKeys() {
  const env = { ...process.env };
  if (existsSync(KEYS_FILE)) {
    try {
      // Parse "NAME=value" lines; skip blank lines and # comments and strip surrounding quotes.
      const lines = readFileSync(KEYS_FILE, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq > 0) {
          const key = trimmed.slice(0, eq).trim();
          const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
          if (!env[key]) env[key] = val;
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  return {
    gemini: env.GEMINI_API_KEY || null,
    grok: env.XAI_API_KEY || env.GROK_API_KEY || null,
    openai: env.OPENAI_API_KEY || null,
    anthropic: env.ANTHROPIC_API_KEY || null,
  };
}

// Save or replace one NAME=value line in the key file. The name must look like an environment variable; line breaks are removed from the value; the folder is private (700) and the file is owner-only (600).
export function saveKey(name, value) {
  if (!name || typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error('invalid key name');
  }
  const cleanVal = String(value ?? '').replace(/[\r\n]+/g, '');
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  let content = '';
  if (existsSync(KEYS_FILE)) content = readFileSync(KEYS_FILE, 'utf8');
  const lines = content.split('\n');
  let replaced = false;
  // Replace the existing line for this name, or add a new line at the end.
  const newLines = lines.map((line) => {
    if (line.trim().startsWith(`${name}=`)) {
      replaced = true;
      return `${name}=${cleanVal}`;
    }
    return line;
  });
  if (!replaced) newLines.push(`${name}=${cleanVal}`);
  writeFileSync(KEYS_FILE, newLines.filter(Boolean).join('\n') + '\n', { mode: 0o600 });
  try { chmodSync(KEYS_FILE, 0o600); } catch {}
}

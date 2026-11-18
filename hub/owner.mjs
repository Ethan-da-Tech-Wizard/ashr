// Program: ashr - owner.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Works out which GitHub name labels the agents on this hub: the ASHR_OWNER setting, the signed-in gh user, git config, or the computer's user name.
// Who runs this hub. Every agent on this laptop is labelled with this GitHub name on the phone.
// Order: ASHR_OWNER env, the signed-in `gh` user, git's github.user, then the laptop user name.
// Helpers for running a program and reading the computer's user name.
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

// A pattern for a valid GitHub name.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
// Return the value if it is a valid name, otherwise null.
export const validOwner = (v) => (typeof v === 'string' && LOGIN.test(v) ? v : null);

// Run a command (3 second limit) and return its trimmed output, or "" if it fails.
const ask = (run, cmd, args) => {
  try {
    return String(run(cmd, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  } catch {
    return '';
  }
};

// Try each source in order and use the first valid name; fall back to "unknown". The environment, command runner and user lookup can be replaced for tests.
export function resolveOwner({ env = process.env, run = execFileSync, user = () => userInfo().username } = {}) {
  return validOwner(env.ASHR_OWNER)
    || validOwner(ask(run, 'gh', ['api', 'user', '--jq', '.login']))
    || validOwner(ask(run, 'git', ['config', '--get', 'github.user']))
    || validOwner(user())
    || 'unknown';
}

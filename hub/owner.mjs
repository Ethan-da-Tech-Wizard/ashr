// Who runs this hub. Every agent on this laptop is labelled with this GitHub name on the phone.
// Order: ASHR_OWNER env, the signed-in `gh` user, git's github.user, then the laptop user name.
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

// GitHub login rules: alphanumeric or hyphen, no leading/trailing hyphen, max 39 chars.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
// Return the name if it is a plausible GitHub login, else null.
export const validOwner = (v) => (typeof v === 'string' && LOGIN.test(v) ? v : null);

// Run a helper command and return trimmed stdout, or '' on any failure.
// A 3 s timeout and ignored stdin/stderr keep a missing or hung `gh` from stalling startup.
const ask = (run, cmd, args) => {
  try {
    return String(run(cmd, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  } catch {
    return '';
  }
};

// Work out the owner label. `run` and `user` are injectable so tests need no real gh/git.
// Each source is validated, so odd values fall through to the next source.
export function resolveOwner({ env = process.env, run = execFileSync, user = () => userInfo().username } = {}) {
  return validOwner(env.ASHR_OWNER)
    || validOwner(ask(run, 'gh', ['api', 'user', '--jq', '.login']))
    || validOwner(ask(run, 'git', ['config', '--get', 'github.user']))
    || validOwner(user())
    || 'unknown';
}

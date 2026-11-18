// Who runs this hub. Every agent on this laptop is labelled with this GitHub name on the phone.
// Order: ASHR_OWNER env, the signed-in `gh` user, git's github.user, then the laptop user name.
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
export const validOwner = (v) => (typeof v === 'string' && LOGIN.test(v) ? v : null);

const ask = (run, cmd, args) => {
  try {
    return String(run(cmd, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  } catch {
    return '';
  }
};

export function resolveOwner({ env = process.env, run = execFileSync, user = () => userInfo().username } = {}) {
  return validOwner(env.ASHR_OWNER)
    || validOwner(ask(run, 'gh', ['api', 'user', '--jq', '.login']))
    || validOwner(ask(run, 'git', ['config', '--get', 'github.user']))
    || validOwner(user())
    || 'unknown';
}

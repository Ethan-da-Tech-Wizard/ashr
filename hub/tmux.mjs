// tmux control via execFile only (never a shell string).
//
// How it fits: routes.apiSay and apiKill call typeInto/interrupt so the phone can talk to an
//   agent running in a tmux pane (the pane id is recorded from the X-Ashr-Pane hook header or
//   by scripts/start-agents.sh). validTarget() is also used by routes.mjs before storing a
//   pane id, so only well-formed targets ever reach tmux.
// Security: text from the phone is attacker-influenced, so tmux is run with an argument array
//   (no shell) and typed text is sent with -l (literal); targets are regex-validated.
// Limits: requires `tmux` on PATH; each call times out after 5 s. Test: test/tmux.test.mjs.
import { execFile } from 'node:child_process';

// Run tmux with an argument array via execFile: no shell is involved, so text from the phone cannot inject commands. 5 s timeout.
const run = (args) =>
  new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000 }, (err) => (err ? reject(err) : resolve()));
  });

// Pane ids look like %3; targets from start-agents look like ashr:1.
/**
 * @param {unknown} t - candidate tmux target.
 * @returns {boolean} true for `%<n>` pane ids or `session:window[.pane]` names built from
 *   word characters, dots and hyphens (no spaces, quotes or shell metacharacters).
 */
export const validTarget = (t) => typeof t === 'string' && /^(%\d+|[\w.-]+:[\w.-]+(\.\d+)?)$/.test(t);

// Type `text` into a pane and press Enter. `-l` sends it literally so words like "Enter" or "C-c" in the text are not interpreted as key names; `--` stops option parsing.
/**
 * @param {string} target - validated tmux target.
 * @param {string} text - characters to type; newlines should already be removed by the caller.
 * @returns {Promise<void>}
 * @throws {Error} 'invalid tmux target', or the tmux error (not installed, pane gone, timeout).
 */
export async function typeInto(target, text) {
  if (!validTarget(target)) throw new Error('invalid tmux target');
  await run(['send-keys', '-t', target, '-l', '--', String(text ?? '')]);
  await run(['send-keys', '-t', target, 'Enter']);
}

// Send Ctrl-C to the pane.
/**
 * @param {string} target - validated tmux target.
 * @returns {Promise<void>} resolves after C-c is sent (asks the agent to stop what it is doing).
 * @throws {Error} as for typeInto.
 */
export async function interrupt(target) {
  if (!validTarget(target)) throw new Error('invalid tmux target');
  return run(['send-keys', '-t', target, 'C-c']);
}

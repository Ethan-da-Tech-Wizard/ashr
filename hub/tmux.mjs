// tmux control via execFile only (never a shell string).
import { execFile } from 'node:child_process';

// Run tmux with an argument array via execFile: no shell is involved, so text from the phone cannot inject commands. 5 s timeout.
const run = (args) =>
  new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000 }, (err) => (err ? reject(err) : resolve()));
  });

// Pane ids look like %3; targets from start-agents look like ashr:1.
export const validTarget = (t) => typeof t === 'string' && /^(%\d+|[\w.-]+:[\w.-]+(\.\d+)?)$/.test(t);

// Type `text` into a pane and press Enter. `-l` sends it literally so words like "Enter" or "C-c" in the text are not interpreted as key names; `--` stops option parsing.
export async function typeInto(target, text) {
  if (!validTarget(target)) throw new Error('invalid tmux target');
  await run(['send-keys', '-t', target, '-l', '--', String(text ?? '')]);
  await run(['send-keys', '-t', target, 'Enter']);
}

// Send Ctrl-C to the pane.
export async function interrupt(target) {
  if (!validTarget(target)) throw new Error('invalid tmux target');
  return run(['send-keys', '-t', target, 'C-c']);
}

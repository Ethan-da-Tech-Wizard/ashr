// tmux control via execFile only (never a shell string).
import { execFile } from 'node:child_process';

const run = (args) =>
  new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000 }, (err) => (err ? reject(err) : resolve()));
  });

// Pane ids look like %3; targets from start-agents look like ashr:1.
export const validTarget = (t) => typeof t === 'string' && /^(%\d+|[\w.-]+:[\w.-]+(\.\d+)?)$/.test(t);

export async function typeInto(target, text) {
  if (!validTarget(target)) throw new Error('invalid tmux target');
  await run(['send-keys', '-t', target, '-l', '--', String(text ?? '')]);
  await run(['send-keys', '-t', target, 'Enter']);
}

export async function interrupt(target) {
  if (!validTarget(target)) throw new Error('invalid tmux target');
  return run(['send-keys', '-t', target, 'C-c']);
}

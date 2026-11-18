// Program: ashr - tmux.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Types text into, or interrupts, an agent's tmux pane by running tmux directly (never through a shell string).
// tmux control via execFile only (never a shell string).
// execFile runs a program with an argument list and no shell, which avoids command injection.
import { execFile } from 'node:child_process';

// Run tmux with the given arguments (5 second limit) and return a promise.
const run = (args) =>
  new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000 }, (err) => (err ? reject(err) : resolve()));
  });

// A valid target is a pane id such as %3 or a name such as ashr:1 or ashr:1.0; anything else is rejected.
// Pane ids look like %3; targets from start-agents look like ashr:1.
export const validTarget = (t) => typeof t === 'string' && /^(%\d+|[\w.-]+:[\w.-]+(\.\d+)?)$/.test(t);

// Type text literally into the pane (the -l flag stops tmux reading key names), then press Enter.
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

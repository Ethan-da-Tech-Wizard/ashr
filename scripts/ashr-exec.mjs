#!/usr/bin/env node
// ashr runner: execute any command under ashr's protective guard.
// Usage: node scripts/ashr-exec.mjs [--agent gemini|codex|claude] [--title "Task"] <command> [args...]
// Example: node scripts/ashr-exec.mjs --agent gemini rm -rf ./tmp
// How it works: the command is NOT run until the hub approves it. The hub scores
// the command and, if risky, waits for a decision from the phone. Exit status is
// that of the command, or 1 if it was denied or the hub could not be reached.
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';

// Settings default from environment variables and can be overridden by flags that must come before the command.
const args = process.argv.slice(2);
let agent = process.env.ASHR_AGENT || 'gemini';
let title = process.env.ASHR_TITLE || '';
let port = Number(process.env.PORT) || 7777;
let token = process.env.ASHR_AGENT_TOKEN || '';

// Consume leading --agent/--title/--port/--token flags; the first non-flag word starts the real command.
while (args.length > 0) {
  if (args[0] === '--agent' && args[1]) {
    agent = args[1];
    args.splice(0, 2);
  } else if (args[0] === '--title' && args[1]) {
    title = args[1];
    args.splice(0, 2);
  } else if (args[0] === '--port' && args[1]) {
    port = Number(args[1]);
    args.splice(0, 2);
  } else if (args[0] === '--token' && args[1]) {
    token = args[1];
    args.splice(0, 2);
  } else {
    break;
  }
}

if (args.length === 0) {
  console.error('Usage: ashr-exec [--agent gemini|codex|claude] [--title "Task"] [--token <token>] <command> [args...]');
  process.exit(1);
}

// Joined only for display and scoring; execution below uses the original argv array.
const command = args.join(' ');
// Stable per-parent id so repeated commands from one agent group under one phone tile.
const sessionId = process.env.ASHR_SESSION_ID || `${agent}-${process.ppid || process.pid}`;
const cwd = process.cwd();
if (!title) title = path.basename(cwd);

// Pick the credential to send: an explicit token, or (when ASHR_AUTO_TOKEN=1) a fresh
// scoped token requested from the hub's localhost-only endpoint. Returns '' if none.
async function obtainToken() {
  if (token) return token;
  if (process.env.ASHR_AUTO_TOKEN === '1') {
    return new Promise((resolve) => {
      const payload = JSON.stringify({ agentId: agent, role: 'worker', capabilities: ['hook:permission', 'hook:event'] });
      const req = http.request(
        `http://127.0.0.1:${port}/hook/agent-token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            try {
              const data = JSON.parse(body);
              if (data.ok && data.token) return resolve(data.token);
            } catch {}
            resolve('');
          });
        }
      );
      req.on('error', () => resolve(''));
      req.write(payload);
      req.end();
    });
  }
  return '';
}

// POST the command to /hook/permission and resolve with the hub's decision
// ({ behavior: 'allow' | 'deny', message? }). Rejects on HTTP errors or an unreachable hub.
async function askPermission() {
  const activeToken = await obtainToken();
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      session_id: sessionId,
      agent,
      title,
      cwd,
      tool_name: 'Bash',
      tool_input: { command },
    });

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-Ashr-Agent': agent,
      'X-Ashr-Pane': process.env.TMUX_PANE || '',
    };
    if (activeToken) {
      headers['Authorization'] = `Bearer ${activeToken}`;
    }

    const req = http.request(
      `http://127.0.0.1:${port}/hook/permission`,
      {
        method: 'POST',
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (res.statusCode >= 400) {
              return reject(new Error(data.error || `HTTP ${res.statusCode}`));
            }
            const decision = data.hookSpecificOutput?.decision || {};
            resolve(decision);
          } catch {
            reject(new Error(`Invalid response from ashr hub (${res.statusCode})`));
          }
        });
      }
    );

    req.on('error', (err) => {
      // If hub is not running, fail closed with clear error.
      reject(new Error(`Could not reach ashr hub on port ${port}: ${err.message}`));
    });

    req.write(payload);
    req.end();
  });
}

try {
  const decision = await askPermission();
  if (decision.behavior !== 'allow') {
    console.error(`\x1b[31m[ashr] Command blocked:\x1b[0m ${decision.message || 'Denied from phone'}`);
    process.exit(1);
  }

  // shell: false means arguments are passed straight to the program, with no shell expansion.
  // Allowed: run the command with inherited stdio
  const child = spawn(args[0], args.slice(1), {
    stdio: 'inherit',
    shell: false,
  });

  child.on('error', (err) => {
    console.error(`[ashr] Failed to run ${args[0]}: ${err.message}`);
    process.exit(1);
  });

  child.on('close', (code) => {
    process.exit(code ?? 0);
  });
} catch (err) {
  console.error(`\x1b[31m[ashr error]\x1b[0m ${err.message}`);
  process.exit(1);
}

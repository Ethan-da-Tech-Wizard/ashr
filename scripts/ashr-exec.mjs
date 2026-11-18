#!/usr/bin/env node
// Program: ashr - ashr-exec.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Command-line runner that asks the ashr hub for permission before running any command, then runs it only if the phone user allows it.
// ashr runner: execute any command under ashr's protective guard.
// Usage: node scripts/ashr-exec.mjs [--agent gemini|codex|claude] [--title "Task"] <command> [args...]
// Example: node scripts/ashr-exec.mjs --agent gemini rm -rf ./tmp
// HTTP client, process spawning and path helpers.
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';

// Start with the command-line arguments after "node script.js".
const args = process.argv.slice(2);
// Settings come from environment variables first: agent name, title, hub port and an optional agent token.
let agent = process.env.ASHR_AGENT || 'gemini';
let title = process.env.ASHR_TITLE || '';
let port = Number(process.env.PORT) || 7777;
let token = process.env.ASHR_AGENT_TOKEN || '';

// Read the leading options (--agent, --title, --port, --token) and remove them from args; what is left is the command to run.
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

// No command given: print how to use the script and exit with an error.
if (args.length === 0) {
  console.error('Usage: ashr-exec [--agent gemini|codex|claude] [--title "Task"] [--token <token>] <command> [args...]');
  process.exit(1);
}

// Build the display text of the command, a session id and the working folder; the title defaults to the folder name.
const command = args.join(' ');
const sessionId = process.env.ASHR_SESSION_ID || `${agent}-${process.ppid || process.pid}`;
const cwd = process.cwd();
if (!title) title = path.basename(cwd);

// Get a token for the hub: use the given one, or (if ASHR_AUTO_TOKEN is 1) ask the hub to issue a worker token. Returns "" if none.
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

// Send the command to the hub's permission endpoint and wait for the decision (this may wait for the phone). Rejects if the hub is unreachable (the command is then not run) or returns an error.
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

    // Request headers include the agent name and tmux pane, and the token if we have one.
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
          // Main flow: ask permission; if not allowed, print the reason and exit with 1.
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

  // Allowed: run the command with inherited stdio
  // Allowed: run the command directly (no shell) with the terminal attached, and exit with the same exit code.
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
// Any error (for example the hub being down) stops here without running the command.
} catch (err) {
  console.error(`\x1b[31m[ashr error]\x1b[0m ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
// Program: ashr - gemini-hook.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Hook script for the Gemini CLI: reads the tool-call JSON from stdin, asks the local ashr hub for permission and prints whether Gemini may continue.
// Gemini CLI hook for ashr: intercepts tool calls and validates them via ashr hub.
// Stdin receives Gemini CLI hook JSON; stdout emits { continue: bool, stopReason?: string }.
// Node's built-in HTTP client, used to call the hub.
import http from 'node:http';

// The hub port, from the PORT environment variable or 7777.
const port = Number(process.env.PORT) || 7777;

// Read all of stdin (capped at about 2 MB).
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 2_000_000) break;
}

// Empty input: allow and exit. (This hook allows when it cannot decide.)
if (!input.trim()) {
  process.stdout.write(JSON.stringify({ continue: true }) + '\n');
  process.exit(0);
}

// Parse the JSON; on invalid JSON allow and exit.
let packet;
try {
  packet = JSON.parse(input);
} catch {
  process.stdout.write(JSON.stringify({ continue: true }) + '\n');
  process.exit(0);
}

// Work out the event name, a session id (from the packet or the parent process id) and the working folder.
const event = packet.event || packet.hook_event_name || 'BeforeTool';
const sessionId = packet.session_id || `gemini-${process.ppid || process.pid}`;
const cwd = packet.cwd || process.cwd();

// Translate a Gemini tool name into the names the hub understands (Bash, Write, Edit, Read) by looking for keywords; unknown tools keep their name.
function mapTool(name, rawInput = {}) {
  const n = String(name || '').toLowerCase();
  if (n.includes('shell') || n.includes('bash') || n.includes('command') || n.includes('exec')) {
    return { tool_name: 'Bash', tool_input: { command: rawInput.command || rawInput.cmd || '' } };
  }
  if (n.includes('write')) {
    return { tool_name: 'Write', tool_input: rawInput };
  }
  if (n.includes('edit') || n.includes('replace') || n.includes('patch')) {
    return { tool_name: 'Edit', tool_input: rawInput };
  }
  if (n.includes('read')) {
    return { tool_name: 'Read', tool_input: rawInput };
  }
  return { tool_name: name || 'Action', tool_input: rawInput };
}

// Before a tool runs: send it to the hub's permission endpoint and wait for the answer.
if (event === 'BeforeTool') {
  const { tool_name, tool_input } = mapTool(packet.tool_name, packet.tool_input);
  // The JSON body sent to the hub, labelled as the gemini agent.
  const payload = JSON.stringify({
    session_id: sessionId,
    agent: 'gemini',
    title: packet.title || cwd.split('/').pop() || 'gemini-task',
    cwd,
    tool_name,
    tool_input,
  });

  // POST to the hub, including the tmux pane (if any) in a header.
  const req = http.request(
    `http://127.0.0.1:${port}/hook/permission`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Ashr-Agent': 'gemini',
        'X-Ashr-Pane': process.env.TMUX_PANE || '',
      },
    },
    // Read the hub's answer: allow means continue; anything else stops Gemini with the reason (or a default message). Unreadable answers allow.
    (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const decision = data.hookSpecificOutput?.decision || {};
          if (decision.behavior === 'allow') {
            process.stdout.write(JSON.stringify({ continue: true }) + '\n');
          } else {
            const reason = decision.message || 'Denied from phone via ashr';
            process.stdout.write(JSON.stringify({ continue: false, stopReason: reason }) + '\n');
          }
        } catch {
          process.stdout.write(JSON.stringify({ continue: true }) + '\n');
        }
      });
    }
  );

  // If the hub cannot be reached, allow so the user is not blocked.
  req.on('error', () => {
    // If hub is down, permit to avoid blocking user offline
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
  });

  // Send the body and finish the request.
  req.write(payload);
  req.end();
// Other events (notifications and lifecycle): tell the hub in the background and let Gemini continue.
} else {
  // Notification / Lifecycle event
  const payload = JSON.stringify({
    session_id: sessionId,
    agent: 'gemini',
    hook_event_name: event,
    cwd,
  });

  const req = http.request(`http://127.0.0.1:${port}/hook/event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-Ashr-Agent': 'gemini',
      'X-Ashr-Pane': process.env.TMUX_PANE || '',
    },
  });
  req.on('error', () => {});
  req.write(payload);
  req.end();
  process.stdout.write(JSON.stringify({ continue: true }) + '\n');
}

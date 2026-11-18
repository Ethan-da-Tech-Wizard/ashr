#!/usr/bin/env node
// Gemini CLI hook for ashr: intercepts tool calls and validates them via ashr hub.
// Stdin receives Gemini CLI hook JSON; stdout emits { continue: bool, stopReason?: string }.
import http from 'node:http';

const port = Number(process.env.PORT) || 7777;

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 2_000_000) break;
}

if (!input.trim()) {
  process.stdout.write(JSON.stringify({ continue: true }) + '\n');
  process.exit(0);
}

let packet;
try {
  packet = JSON.parse(input);
} catch {
  process.stdout.write(JSON.stringify({ continue: true }) + '\n');
  process.exit(0);
}

const event = packet.event || packet.hook_event_name || 'BeforeTool';
const sessionId = packet.session_id || `gemini-${process.ppid || process.pid}`;
const cwd = packet.cwd || process.cwd();

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

if (event === 'BeforeTool') {
  const { tool_name, tool_input } = mapTool(packet.tool_name, packet.tool_input);
  const payload = JSON.stringify({
    session_id: sessionId,
    agent: 'gemini',
    title: packet.title || cwd.split('/').pop() || 'gemini-task',
    cwd,
    tool_name,
    tool_input,
  });

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

  req.on('error', () => {
    // If hub is down, permit to avoid blocking user offline
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
  });

  req.write(payload);
  req.end();
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

#!/usr/bin/env node
// Gemini CLI hook for ashr: intercepts tool calls and validates them via ashr hub.
// Stdin receives Gemini CLI hook JSON; stdout emits { continue: bool, stopReason?: string }.
// Fail-open by design: if the hub is unreachable, the input is empty or malformed, or the
// reply cannot be parsed, the tool call is allowed so that ashr outages never block the user.
// Only an explicit deny from the hub stops the call.
//
// How it fits: meant to be registered as a Gemini CLI BeforeTool/notification hook in
//   Gemini's own settings (no script in this repo installs that registration for you). Claude Code needs no script because it has native HTTP hooks
//   (hooks/claude-settings.json). This script is the Gemini equivalent: it converts Gemini's hook
//   JSON into the same request the hub's /hook/permission and /hook/event expect, so one hub, one
//   guard (guard/rules.mjs) and one phone UI serve every agent. Runs once per hook invocation (a
//   short-lived process), so it keeps no state.
// Why fail-open: a `{continue: true}` reply only means "ashr does not object"; it does not
//   pre-approve anything, so Gemini still applies its own confirmation rules. The design choice is
//   that an ashr outage must not freeze a developer's agent. The cost is that while the hub is down
//   NOTHING is checked for Gemini. Change the three `continue: true` fallbacks below to
//   `continue: false` if you prefer fail-closed. This is documented here because it is a deliberate
//   safety trade-off, not an oversight.
// Inputs/outputs: stdin JSON (event, tool_name, tool_input, session_id, cwd); stdout one JSON line
//   {continue: boolean, stopReason?: string}. Env: PORT (hub port, default 7777), TMUX_PANE.
// Test: none exists for this hook (it needs a live Gemini CLI); the mapTool logic is simple enough
//   to check by piping sample JSON into it with a hub running.
import http from 'node:http';

// Hub port; the hub is always addressed on loopback.
const port = Number(process.env.PORT) || 7777;

// Read all of stdin (capped at about 2 MB) before parsing.
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
// Without a session id, fall back to the parent process id so one Gemini run keeps one session.
const sessionId = packet.session_id || `gemini-${process.ppid || process.pid}`;
const cwd = packet.cwd || process.cwd();

// Translate Gemini tool names into the Claude-style names the hub's guard understands
// (Bash/Write/Edit/Read), by substring match. Unknown tools keep their own name and are scored MEDIUM.
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

// BeforeTool: ask the hub for a permission decision and print Gemini's { continue } verdict.
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
        // The tmux pane lets the phone type replies into this agent.
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
  // Other events are informational: post and allow immediately without waiting for the reply.
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

#!/usr/bin/env node
// Program: ashr - grok-agent.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: A small Grok (xAI) agent runner: sends a prompt to Grok with three tools, then asks the ashr hub before executing each tool call it proposes.
// Grok (xAI) agent runner guarded by ashr.
// Zero npm dependencies. Uses Node 24 native fetch.
// Every tool execution is evaluated by ashr hub before running.
// Node helpers for running a program, reading and writing files, and resolving paths, plus the key loader.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadKeys } from '../hub/keys.mjs';

// Find the API key (environment, then the key file), the hub port, a session id, the working folder and a task title.
const keys = loadKeys();
const apiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY || keys.grok;
const port = Number(process.env.PORT) || 7777;
const sessionId = process.env.ASHR_SESSION_ID || `grok-${process.ppid || process.pid}`;
const cwd = process.cwd();
const title = process.env.ASHR_TITLE || cwd.split('/').pop() || 'grok-task';

// Stop with a message if there is no key.
if (!apiKey) {
  console.error('\x1b[31m[grok-agent]\x1b[0m No xAI API key found. Set XAI_API_KEY or add it to ~/.config/ashr/keys.env');
  process.exit(1);
}

// The task text comes from the command line, or a default.
const prompt = process.argv.slice(2).join(' ') || 'Run project tests and inspect code quality.';

// The tool list sent to Grok in function-calling format: Bash (run a command), Read (read a file) and Write (write a file).
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Run a shell command in the project directory',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Command to execute' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string', description: 'Path to file' } },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Write content to a file',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to file' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
];

// Ask the hub for permission for one tool call. If the hub cannot be reached or gives no decision, the answer is deny.
async function askAshr(tool_name, tool_input) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/hook/permission`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ashr-Agent': 'grok',
        'X-Ashr-Pane': process.env.TMUX_PANE || '',
      },
      body: JSON.stringify({
        session_id: sessionId,
        agent: 'grok',
        title,
        cwd,
        tool_name,
        tool_input,
      }),
    });
    const data = await res.json();
    return data.hookSpecificOutput?.decision || { behavior: 'deny', message: 'No decision returned' };
  } catch (err) {
    return { behavior: 'deny', message: `Could not reach ashr hub: ${err.message}` };
  }
}

// Run an approved tool: Bash through bash -c (30 second limit), Read (first 10000 characters), Write. Errors are returned as text.
function runTool(name, input) {
  return new Promise((resolve) => {
    if (name === 'Bash') {
      execFile('bash', ['-c', input.command], { cwd, timeout: 30000 }, (err, stdout, stderr) => {
        resolve((stdout || '') + (stderr || '') + (err ? `\nExit code: ${err.code}` : ''));
      });
    } else if (name === 'Read') {
      try {
        const full = resolve(cwd, input.file_path);
        resolve(readFileSync(full, 'utf8').slice(0, 10000));
      } catch (err) {
        resolve(`Error reading file: ${err.message}`);
      }
    } else if (name === 'Write') {
      try {
        const full = resolve(cwd, input.file_path);
        writeFileSync(full, input.content, 'utf8');
        resolve('File written successfully.');
      } catch (err) {
        resolve(`Error writing file: ${err.message}`);
      }
    } else {
      resolve(`Unknown tool: ${name}`);
    }
  });
}

console.log(`\x1b[36m[ashr grok-agent]\x1b[0m Session: ${sessionId} | Task: ${prompt}`);

// The conversation: a system message and the user's task.
const messages = [
  { role: 'system', content: 'You are Grok, an autonomous coding agent guarded by ashr. Use tools to complete user requests.' },
  { role: 'user', content: prompt },
];

// Call the Grok chat API once. If it proposes tool calls, show each, ask the hub, then run only allowed ones. Otherwise print Grok's text answer.
try {
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'grok-2-latest',
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error(`\x1b[31m[grok error]\x1b[0m API returned ${res.status}: ${txt}`);
    process.exit(1);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  // A list of tool calls proposed by the model, if any.
  const toolCalls = choice?.message?.tool_calls;

  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      const toolName = tc.function.name;
      const toolArgs = JSON.parse(tc.function.arguments || '{}');
      console.log(`[grok] Proposing ${toolName}: ${JSON.stringify(toolArgs)}`);
      
      const decision = await askAshr(toolName, toolArgs);
      if (decision.behavior === 'allow') {
        console.log(`\x1b[32m[ashr allowed]\x1b[0m Executing ${toolName}...`);
        const result = await runTool(toolName, toolArgs);
        console.log(`[result]:\n${result}`);
      } else {
        console.log(`\x1b[31m[ashr blocked]\x1b[0m ${decision.message || 'Denied from phone'}`);
      }
    }
  } else {
    console.log(`[grok response]:\n${choice?.message?.content || 'No text output.'}`);
  }
} catch (err) {
  console.error(`[grok failure]: ${err.message}`);
}

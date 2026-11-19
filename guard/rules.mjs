// ==============================================================================
// Program: rules.mjs
// Programmer: Ethan-da-Tech-Wizard
// Last Modified: November 18, 2026
// Purpose: Risk scoring and security policy evaluation for agent tool calls
//
// How it fits: this is the policy brain of ashr. hub/routes.mjs calls score() for every
//   /hook/permission request and acts on the result: low = allow silently, medium/high = hold the
//   request for the phone. Bash commands are delegated to bash.mjs (which uses lex.mjs), secret
//   detection to secrets.mjs, and file, read and network tools are scored in this file.
//
// Policy in one paragraph: only positively-recognised read-only actions and ordinary in-project
//   edits are LOW; anything touching credentials, writing outside the project, running as root,
//   deleting recursively or containing a secret is HIGH; unknown tools and shell commands that are
//   not clearly safe are MEDIUM. Malformed input degrades to MEDIUM, never to LOW ("fail toward
//   caution").
//
// Result shape: { risk, reasons: string[], summary (<= 80 chars for the phone card), detail }.
// Known limits: scoring is pattern based, not a sandbox; a determined agent could phrase a harmful
//   command the patterns do not know. docs/THREAT-MODEL.md lists what is and is not covered.
// Test: test/guard.test.mjs, test/guard-secrets.test.mjs and test/fuzz.test.mjs.
// ==============================================================================
// Risk scoring for agent tool calls.
// score() is async (runs git-secret-shield without blocking). scoreSync() is regex-only, same rules.
import path from 'node:path';
// Result shape for every scorer: { risk: 'low'|'medium'|'high', reasons: string[], summary, detail }.
import { scanSecrets, scanSecretsSync, SCAN_FAILED } from './secrets.mjs';
import { scoreBash, SENSITIVE_PATH, touchesSensitive } from './bash.mjs';

// Read-only tools: LOW unless they point at sensitive files.
// Tool-name tables use Claude Code's names; hooks/gemini-hook.mjs maps Gemini's tool names onto
// these before calling the hub, so one rule set serves every agent.
const SAFE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'NotebookRead']);
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
// Build, CI and tool configuration files: edits are MEDIUM because they can change how code runs.
const CONFIG_PATH = /(^|\/)(package\.json|tsconfig[\w.-]*\.json|Dockerfile|docker-compose[\w.-]*|\.github\/.*|[\w.-]+\.(ya?ml|toml|ini|conf)|\.[a-z]+rc|[\w.-]+\.config\.[mc]?[jt]s)$/;

// Shorten text for the phone-sized summary.
/**
 * @param {string} s - text to shorten.
 * @param {number} [n=80] - maximum length including the ellipsis (80 fits a phone card).
 * @returns {string}
 */
const trunc = (s, n = 80) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
// Numeric order of the three levels so tracker().bump can compare them.
const rank = { low: 0, medium: 1, high: 2 };

// True if target is the project directory or under it (no cwd means no restriction).
/**
 * @param {string} target - absolute path.
 * @param {string} cwd - project directory ('' = unknown, which counts as inside).
 * @returns {boolean} whether target is cwd or below it. path.relative starts with '..' (or is
 *   absolute on another drive) exactly when the target is outside.
 */
function inside(target, cwd) {
  if (!cwd) return true;
  const rel = path.relative(path.resolve(cwd), target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Accumulates the highest risk seen and the list of reasons. bump(risk, why) never lowers the risk.
/**
 * @returns {{risk: string, reasons: string[], bump: (r: string, why: string) => void}} mutable
 *   accumulator shared with bash.mjs. Reasons are de-duplicated so the phone shows each once.
 */
function tracker() {
  const t = { risk: 'low', reasons: [] };
  t.bump = (r, why) => {
    if (!t.reasons.includes(why)) t.reasons.push(why);
    if (rank[r] > rank[t.risk]) t.risk = r;
  };
  return t;
}

// Convert secret-scan labels to findings: any hit is HIGH, a failed scan is MEDIUM (could not verify).
/**
 * @param {object} t - tracker to update.
 * @param {string[]} found - labels from scanSecrets.
 * @param {string} label - prefix for the reason text, e.g. 'secret in content'.
 * @returns {void}
 */
function applySecrets(t, found, label) {
  for (const f of found) {
    if (f === SCAN_FAILED) t.bump('medium', SCAN_FAILED);
    else t.bump('high', `${label}: ${f}`);
  }
}

/**
 * @param {{command?: string}} input - Bash tool input.
 * @param {string} cwd - project directory.
 * @param {string[]} found - secret-scan labels.
 * @returns {object} verdict; the summary collapses whitespace so multi-line commands fit one line.
 */
function bash(input, cwd, found) {
  const cmd = String(input.command ?? '');
  const t = tracker();
  scoreBash(cmd, cwd, found, t);
  return { risk: t.risk, reasons: t.reasons, summary: trunc(cmd.replace(/\s+/g, ' ').trim()), detail: cmd };
}

// Extract the text being written, from Write (content), Edit (new_string) or MultiEdit (edits[]).
/**
 * @param {object} input - Write/Edit/MultiEdit tool input.
 * @returns {string} text that would be written ('' if none), for secret scanning and display.
 */
function contentOf(input) {
  if (typeof input.content === 'string') return input.content;
  if (typeof input.new_string === 'string') return input.new_string;
  if (Array.isArray(input.edits)) return input.edits.map((e) => e?.new_string ?? '').join('\n');
  return '';
}

// Score Edit/Write/MultiEdit: sensitive path or outside-project writes are HIGH, config files MEDIUM, and the content is scanned for secrets.
/**
 * @param {string} tool - 'Edit' | 'Write' | 'MultiEdit'.
 * @param {object} input - {file_path|path, content|new_string|edits}.
 * @param {string} cwd - project directory ('' disables the outside-project check).
 * @param {string[]} found - secret-scan labels for the content.
 * @returns {object} verdict. An ordinary in-project, non-sensitive, secret-free edit stays LOW,
 *   so routine code edits are auto-allowed; the checks below only raise it.
 */
function fileTool(tool, input, cwd, found) {
  const file = String(input.file_path ?? input.path ?? '');
  // Resolve relative paths against the project directory so '../x' is seen as outside it.
  const abs = file ? path.resolve(cwd || '/', file) : '';
  const t = tracker();
  if (abs && SENSITIVE_PATH.test(abs)) t.bump('high', 'touches env file or key');
  if (abs && cwd && !inside(abs, cwd)) t.bump('high', 'writes outside project');
  if (abs && CONFIG_PATH.test(abs)) t.bump('medium', 'config file');
  applySecrets(t, found, 'secret in content');
  const content = contentOf(input);
  // Phone summary shows the project-relative path (shorter, and what the user recognises).
  const rel = cwd && abs ? path.relative(cwd, abs) || file : file;
  const detail = content ? `${file}\n---\n${content}` : file;
  return { risk: t.risk, reasons: t.reasons, summary: `${tool} ${rel}`.trim(), detail };
}

// Read-only tools are LOW unless the path or any pattern/glob could touch credentials.
/**
 * @param {string} name - read-only tool name (Read, Glob, Grep...).
 * @param {object} inp - tool input; file_path/path, pattern and glob are inspected.
 * @param {string} cwd
 * @returns {object} HIGH when any path, pattern or glob could reach a credential file, else LOW.
 */
function safeTool(name, inp, cwd) {
  const file = String(inp.file_path ?? inp.path ?? '');
  const fields = [file, inp.pattern, inp.glob].filter((v) => typeof v === 'string' && v);
  const bad = (file && SENSITIVE_PATH.test(path.resolve(cwd || '/', file))) || fields.some((v) => touchesSensitive(v));
  const summary = `${name} ${file || inp.pattern || ''}`.trim();
  if (bad) return { risk: 'high', reasons: ['touches env file or key'], summary, detail: JSON.stringify(inp) };
  return { risk: 'low', reasons: [], summary, detail: file };
}

// The text the secret scan should look at for this call.
/**
 * @param {string} name - tool name.
 * @param {object} inp - tool input.
 * @returns {string} text for scanSecrets: the command for Bash, the written content for file
 *   tools, '' for others (reading a file does not leak the file's content to anyone).
 */
function scanTarget(name, inp) {
  if (name === 'Bash') return String(inp.command ?? '');
  if (FILE_TOOLS.has(name)) return contentOf(inp);
  return '';
}

// Dispatch by tool name. Unknown tools default to MEDIUM so new tool types are never silently approved.
/**
 * @param {string} name - tool name.
 * @param {object} inp - tool input.
 * @param {string} cwd - project directory.
 * @param {string[]} found - secret-scan labels already computed by the caller.
 * @returns {object} verdict {risk, reasons, summary, detail}.
 */
function evaluate(name, inp, cwd, found) {
  if (name === 'Bash') return bash(inp, cwd, found);
  if (FILE_TOOLS.has(name)) return fileTool(name, inp, cwd, found);
  if (name === 'WebFetch') {
    let host = String(inp.url ?? '');
    try { host = new URL(host).host; } catch { /* keep raw */ }
    return { risk: 'medium', reasons: ['network call'], summary: `Fetch ${host}`, detail: JSON.stringify(inp) };
  }
  if (SAFE_TOOLS.has(name)) return safeTool(name, inp, cwd);
  return { risk: 'medium', reasons: ['unrecognized tool'], summary: name || 'unknown tool', detail: JSON.stringify(inp) };
}

// Coerce arbitrary input to [toolName, inputObject, cwd]; malformed calls become empty values, never exceptions.
/**
 * @param {unknown} call - candidate {tool, input, cwd}.
 * @returns {[string, object, string]} always a valid triple, so scorers never see undefined.
 */
function normalize(call) {
  const { tool, input, cwd } = call && typeof call === 'object' ? call : {};
  return [String(tool ?? ''), input && typeof input === 'object' ? input : {}, cwd ?? ''];
}

// Score a call { tool, input, cwd }. Async because the optional external secret scanner runs as a subprocess.
/**
 * @param {{tool?: string, input?: object, cwd?: string}} [call] - the tool call to rate.
 * @returns {Promise<{risk: 'low'|'medium'|'high', reasons: string[], summary: string, detail: string}>}
 *   never rejects for bad input (it is normalised first).
 */
export async function score(call = {}) {
  const [name, inp, cwd] = normalize(call);
  return evaluate(name, inp, cwd, await scanSecrets(scanTarget(name, inp)));
}

// Same rules without the external scanner (built-in regex and entropy checks only).
/**
 * @param {{tool?: string, input?: object, cwd?: string}} [call]
 * @returns {{risk: string, reasons: string[], summary: string, detail: string}} same as score().
 */
export function scoreSync(call = {}) {
  const [name, inp, cwd] = normalize(call);
  return evaluate(name, inp, cwd, scanSecretsSync(scanTarget(name, inp)));
}

// Program: ashr - rules.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Scores an agent tool call (Bash, file edit, fetch, read-only tools) as low, medium or high risk with reasons, a short summary and detail text.
// Risk scoring for agent tool calls.
// score() is async (runs git-secret-shield without blocking). scoreSync() is regex-only, same rules.
// Imports: path helpers, the secret scanners and the Bash scorer.
import path from 'node:path';
import { scanSecrets, scanSecretsSync, SCAN_FAILED } from './secrets.mjs';
import { scoreBash, SENSITIVE_PATH, touchesSensitive } from './bash.mjs';

// Read-only tools that are low risk unless they touch secret files.
const SAFE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'NotebookRead']);
// Tools that change files.
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
// A regex for configuration files (package.json, Dockerfile, CI files, yaml, toml, rc files); editing them is medium risk.
const CONFIG_PATH = /(^|\/)(package\.json|tsconfig[\w.-]*\.json|Dockerfile|docker-compose[\w.-]*|\.github\/.*|[\w.-]+\.(ya?ml|toml|ini|conf)|\.[a-z]+rc|[\w.-]+\.config\.[mc]?[jt]s)$/;

// Cut a string to n characters and add an ellipsis.
const trunc = (s, n = 80) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
// Numeric order of the risk levels so we can keep the highest.
const rank = { low: 0, medium: 1, high: 2 };

// True when target is inside the working folder (or there is no folder to compare).
function inside(target, cwd) {
  if (!cwd) return true;
  const rel = path.relative(path.resolve(cwd), target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Create a tracker that remembers the highest risk so far and the list of reasons; bump(risk, why) raises the risk if higher and adds the reason once.
function tracker() {
  const t = { risk: 'low', reasons: [] };
  t.bump = (r, why) => {
    if (!t.reasons.includes(why)) t.reasons.push(why);
    if (rank[r] > rank[t.risk]) t.risk = r;
  };
  return t;
}

// Turn secret-scan labels into reasons: a failed scan is medium, any finding is high.
function applySecrets(t, found, label) {
  for (const f of found) {
    if (f === SCAN_FAILED) t.bump('medium', SCAN_FAILED);
    else t.bump('high', `${label}: ${f}`);
  }
}

// Score a Bash call with the shared Bash scorer and build the result object.
function bash(input, cwd, found) {
  const cmd = String(input.command ?? '');
  const t = tracker();
  scoreBash(cmd, cwd, found, t);
  return { risk: t.risk, reasons: t.reasons, summary: trunc(cmd.replace(/\s+/g, ' ').trim()), detail: cmd };
}

// Get the new text from a file tool call (content, new_string or several edits).
function contentOf(input) {
  if (typeof input.content === 'string') return input.content;
  if (typeof input.new_string === 'string') return input.new_string;
  if (Array.isArray(input.edits)) return input.edits.map((e) => e?.new_string ?? '').join('\n');
  return '';
}

// Score an Edit, Write or MultiEdit call: sensitive path or outside the project is high, config files are medium, secrets in the content are high.
function fileTool(tool, input, cwd, found) {
  const file = String(input.file_path ?? input.path ?? '');
  const abs = file ? path.resolve(cwd || '/', file) : '';
  const t = tracker();
  if (abs && SENSITIVE_PATH.test(abs)) t.bump('high', 'touches env file or key');
  if (abs && cwd && !inside(abs, cwd)) t.bump('high', 'writes outside project');
  if (abs && CONFIG_PATH.test(abs)) t.bump('medium', 'config file');
  applySecrets(t, found, 'secret in content');
  const content = contentOf(input);
  const rel = cwd && abs ? path.relative(cwd, abs) || file : file;
  const detail = content ? `${file}\n---\n${content}` : file;
  return { risk: t.risk, reasons: t.reasons, summary: `${tool} ${rel}`.trim(), detail };
}

// Score a read-only tool: high if its path or pattern points at a secret file, otherwise low.
function safeTool(name, inp, cwd) {
  const file = String(inp.file_path ?? inp.path ?? '');
  const fields = [file, inp.pattern, inp.glob].filter((v) => typeof v === 'string' && v);
  const bad = (file && SENSITIVE_PATH.test(path.resolve(cwd || '/', file))) || fields.some((v) => touchesSensitive(v));
  const summary = `${name} ${file || inp.pattern || ''}`.trim();
  if (bad) return { risk: 'high', reasons: ['touches env file or key'], summary, detail: JSON.stringify(inp) };
  return { risk: 'low', reasons: [], summary, detail: file };
}

// Choose the text to scan for secrets: the command for Bash, the new content for file tools, nothing for others.
// The text the secret scan should look at for this call.
function scanTarget(name, inp) {
  if (name === 'Bash') return String(inp.command ?? '');
  if (FILE_TOOLS.has(name)) return contentOf(inp);
  return '';
}

// Pick the right scorer by tool name. Fetching a web page is medium; an unknown tool is medium.
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

// Make a safe [tool, input, cwd] triple from whatever was passed in.
function normalize(call) {
  const { tool, input, cwd } = call && typeof call === 'object' ? call : {};
  return [String(tool ?? ''), input && typeof input === 'object' ? input : {}, cwd ?? ''];
}

// Async scoring: also asks the external secret scanner.
export async function score(call = {}) {
  const [name, inp, cwd] = normalize(call);
  return evaluate(name, inp, cwd, await scanSecrets(scanTarget(name, inp)));
}

// Synchronous scoring: same rules but only the built-in regex secret scan.
export function scoreSync(call = {}) {
  const [name, inp, cwd] = normalize(call);
  return evaluate(name, inp, cwd, scanSecretsSync(scanTarget(name, inp)));
}

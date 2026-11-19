// ==============================================================================
// Program: rules.mjs
// Programmer: Ethan-da-Tech-Wizard
// Last Modified: November 18, 2026
// Purpose: Risk scoring and security policy evaluation for agent tool calls
// ==============================================================================
// Risk scoring for agent tool calls.
// score() is async (runs git-secret-shield without blocking). scoreSync() is regex-only, same rules.
import path from 'node:path';
// Result shape for every scorer: { risk: 'low'|'medium'|'high', reasons: string[], summary, detail }.
import { scanSecrets, scanSecretsSync, SCAN_FAILED } from './secrets.mjs';
import { scoreBash, SENSITIVE_PATH, touchesSensitive } from './bash.mjs';

// Read-only tools: LOW unless they point at sensitive files.
const SAFE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'NotebookRead']);
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
// Build, CI and tool configuration files: edits are MEDIUM because they can change how code runs.
const CONFIG_PATH = /(^|\/)(package\.json|tsconfig[\w.-]*\.json|Dockerfile|docker-compose[\w.-]*|\.github\/.*|[\w.-]+\.(ya?ml|toml|ini|conf)|\.[a-z]+rc|[\w.-]+\.config\.[mc]?[jt]s)$/;

// Shorten text for the phone-sized summary.
const trunc = (s, n = 80) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const rank = { low: 0, medium: 1, high: 2 };

// True if target is the project directory or under it (no cwd means no restriction).
function inside(target, cwd) {
  if (!cwd) return true;
  const rel = path.relative(path.resolve(cwd), target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Accumulates the highest risk seen and the list of reasons. bump(risk, why) never lowers the risk.
function tracker() {
  const t = { risk: 'low', reasons: [] };
  t.bump = (r, why) => {
    if (!t.reasons.includes(why)) t.reasons.push(why);
    if (rank[r] > rank[t.risk]) t.risk = r;
  };
  return t;
}

// Convert secret-scan labels to findings: any hit is HIGH, a failed scan is MEDIUM (could not verify).
function applySecrets(t, found, label) {
  for (const f of found) {
    if (f === SCAN_FAILED) t.bump('medium', SCAN_FAILED);
    else t.bump('high', `${label}: ${f}`);
  }
}

function bash(input, cwd, found) {
  const cmd = String(input.command ?? '');
  const t = tracker();
  scoreBash(cmd, cwd, found, t);
  return { risk: t.risk, reasons: t.reasons, summary: trunc(cmd.replace(/\s+/g, ' ').trim()), detail: cmd };
}

// Extract the text being written, from Write (content), Edit (new_string) or MultiEdit (edits[]).
function contentOf(input) {
  if (typeof input.content === 'string') return input.content;
  if (typeof input.new_string === 'string') return input.new_string;
  if (Array.isArray(input.edits)) return input.edits.map((e) => e?.new_string ?? '').join('\n');
  return '';
}

// Score Edit/Write/MultiEdit: sensitive path or outside-project writes are HIGH, config files MEDIUM, and the content is scanned for secrets.
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

// Read-only tools are LOW unless the path or any pattern/glob could touch credentials.
function safeTool(name, inp, cwd) {
  const file = String(inp.file_path ?? inp.path ?? '');
  const fields = [file, inp.pattern, inp.glob].filter((v) => typeof v === 'string' && v);
  const bad = (file && SENSITIVE_PATH.test(path.resolve(cwd || '/', file))) || fields.some((v) => touchesSensitive(v));
  const summary = `${name} ${file || inp.pattern || ''}`.trim();
  if (bad) return { risk: 'high', reasons: ['touches env file or key'], summary, detail: JSON.stringify(inp) };
  return { risk: 'low', reasons: [], summary, detail: file };
}

// The text the secret scan should look at for this call.
function scanTarget(name, inp) {
  if (name === 'Bash') return String(inp.command ?? '');
  if (FILE_TOOLS.has(name)) return contentOf(inp);
  return '';
}

// Dispatch by tool name. Unknown tools default to MEDIUM so new tool types are never silently approved.
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
function normalize(call) {
  const { tool, input, cwd } = call && typeof call === 'object' ? call : {};
  return [String(tool ?? ''), input && typeof input === 'object' ? input : {}, cwd ?? ''];
}

// Score a call { tool, input, cwd }. Async because the optional external secret scanner runs as a subprocess.
export async function score(call = {}) {
  const [name, inp, cwd] = normalize(call);
  return evaluate(name, inp, cwd, await scanSecrets(scanTarget(name, inp)));
}

// Same rules without the external scanner (built-in regex and entropy checks only).
export function scoreSync(call = {}) {
  const [name, inp, cwd] = normalize(call);
  return evaluate(name, inp, cwd, scanSecretsSync(scanTarget(name, inp)));
}

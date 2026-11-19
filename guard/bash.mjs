// File: guard/bash.mjs
// Purpose: Score a shell command as low/medium/high risk. The command is lexed
// (never executed), split into segments, and each segment is checked against
// deny-patterns, sensitive-path checks and a small read-only allowlist.
// Design rule: fail toward caution. Anything not positively recognised as safe
// is at least MEDIUM, so a human on the phone gets to decide.
// Bash command scoring. Unmatched commands are MEDIUM. LOW comes only from the allowlist below.
// Compound commands score as the max of their parts.
import path from 'node:path';
import { lex, embeddedCommands } from './lex.mjs';

// Matches a path component that names a credential store: .env files, SSH/PEM/PKCS keys,
// cloud and package-manager credential dirs, shell history. The leading class lets it
// match after '/', '@', ':' or at the start, so "scp host:.env" and "@.env" are caught too.
export const SENSITIVE_PATH = /(^|[/@:])(\.env(\.[\w.-]+)?|id_(rsa|ed25519|ecdsa)|[\w.-]+\.(pem|key|p12|pfx)|\.ssh|\.aws|\.kube|\.npmrc|\.netrc|\.git-credentials|credentials|\.(bash|zsh)_history)(\/|$)/;
// Literal names used to test whether a glob (e.g. ".en?" or "id_*") could expand to a sensitive file.
const SENSITIVE_NAMES = ['.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', 'id_ecdsa', '.npmrc', '.netrc', '.git-credentials', 'credentials', '.ssh', '.aws', '.kube', '.zsh_history', '.bash_history']; // leakguard:allow
// /proc/<pid>/environ exposes a process's environment variables (often secrets).
const PROC_ENV = /\/proc\/[^/]+\/environ/;
// Harmless write targets: redirecting to these never touches a real file.
const NULLISH = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;
const GLOB_CHARS = /[?*[\]]/;
// Commands that merely run another command; the real command is the word after them.
const WRAPPERS = new Set(['command', 'exec', 'nohup', 'time', 'nice', 'builtin', 'xargs', 'env']);
// Commands whose every non-flag argument is a path they write to.
const WRITE_ALL = new Set(['tee', 'touch', 'mkdir', 'rmdir', 'ln', 'truncate', 'install']);
// Read-only file viewers that can be LOW risk when limited to in-project, non-sensitive files.
const READERS = new Set(['cat', 'head', 'tail', 'wc', 'grep', 'rg']);
// A "plain" word: no spaces, quotes, globs or shell metacharacters.
const PLAIN = /^[\w.@+,:=/-]+$/;
// `git branch` flags that only list; anything else could create or delete branches.
const SAFE_BRANCH_FLAGS = new Set(['-a', '-r', '-v', '-vv', '--list', '--show-current', '--all', '--remotes']);

// Patterns tested against the raw command text before lexing, because they span
// pipes/segments (e.g. "curl ... | sh") that per-segment checks would miss.
const WHOLE_COMMAND_HIGH = [
  [/\bgit\s+push\b.*(--force\b|--force-with-lease|\s-f\b)/, 'force push'],
  [/\b(curl|wget)\b[^|;\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'pipes download into a shell'],
  [/\b(base64|openssl|xxd)\b[^|;\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'obfuscated decoded pipe into shell'],
  [/\b((ba|z|da)?sh|source|\.)\s*<\s*\(/, 'process substitution into a shell'],
  [/\/dev\/(tcp|udp)\/|\b(nc|ncat|netcat)\b.*-e\b|\bsocat\b.*(exec|system):/i, 'reverse shell / network socket redirect'],
];

// Per-segment HIGH-risk patterns: [regex, human-readable reason].
const HIGH = [
  [/\b(python3?|perl|ruby)\b.*-[ce]\b.*\b(os\.system|subprocess|exec|system|popen)\b/, 'inline script process execution'],
  [/\bnode\b.*-[ep]\b.*\b(child_process|execSync|spawnSync)\b/, 'inline node child process execution'],
  [/\b(shred|wipe|srm)\b/, 'secure file shred / wipe'],
  [/\bsudo\b/, 'runs as root'],
  [/\b(mkfs|dd\s+if=)/, 'disk-level command'],
  [/\bchmod\s+-R\s+777/, 'world-writable permissions'],
  [/\bgit\s+reset\s+--hard/, 'discards local work'],
  [/\b(npm|pnpm|yarn|cargo)\s+publish\b|\b(pip|twine)\s+upload\b/, 'publishes package to public registry'],
  [/\b(shutdown|reboot|poweroff|halt)\b/, 'system power command'],
  [/\b(docker|podman)\s+run\b.*(--privileged\b|-v\s+\/:(host)?\b)/, 'container escape / privileged host mount'],
  [/\/dev\/(tcp|udp)\/|\b(nc|ncat|netcat)\b.*-e\b|\bsocat\b.*(exec|system):/i, 'reverse shell / network socket redirect'],
];
// Per-segment MEDIUM-risk patterns: legitimate but side-effecting actions worth a glance.
const MEDIUM = [
  [/\b(npm|pnpm|yarn|bun)\s+(install|i|add)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bcargo\s+(install|add)\b|\bgem\s+install\b/, 'package install'],
  [/\bgit\s+push\b/, 'git push'],
  [/\b(curl|wget|ssh|scp|rsync|nc|ncat)\b|https?:\/\//, 'network call'],
  [/\bgit\s+(rebase|merge)\b/, 'rewrites git state'],
];

const base = (s) => path.basename(String(s));

// True when absolute path `abs` is the project directory or below it. With no cwd, nothing can be judged, so it is treated as inside.
function inside(abs, cwd) {
  if (!cwd) return true;
  const rel = path.relative(path.resolve(cwd), abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Convert a shell glob to a RegExp (escaping regex metacharacters first); null if it does not compile.
function globRe(g) {
  const s = g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\[!/g, '[^');
  try { return new RegExp(`^${s}$`); } catch { return null; }
}

// True when the word is, or could expand to, an env file or key file.
export function touchesSensitive(val) {
  if (!val) return false;
  const raw = String(val).replace(/^@+/, '');
  // Also test the pieces after '=' or ':' so "--file=.env" and "host:.env" are caught.
  const parts = [val, raw, ...raw.split(/[=:]/).slice(1)];
  for (const p of parts) {
    if (SENSITIVE_PATH.test(p) || PROC_ENV.test(p)) return true;
    if (GLOB_CHARS.test(p)) {
      const re = globRe(base(p));
      if (re && SENSITIVE_NAMES.some((n) => re.test(n))) return true;
    }
  }
  return false;
}

const isFlag = (w) => w.val.startsWith('-') && w.val.length > 1;

// Strip leading VAR=value assignments and wrapper commands (env, nohup, ...) to find the real command.
// Returns { rest, wrapped, envDump }; envDump is true for a bare `env`, which prints every variable.
function skipPrefix(words) {
  let i = 0; let wrapped = false; let envDump = false;
  for (;;) {
    while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i].val)) i++;
    const w = words[i];
    if (!w || !WRAPPERS.has(base(w.val.replace(/^\\/, '')))) break;
    wrapped = true;
    const isEnv = base(w.val) === 'env';
    i++;
    while (i < words.length && (isFlag(words[i]) || (isEnv && /^[A-Za-z_]\w*=/.test(words[i].val)))) i++;
    if (isEnv && i >= words.length) envDump = true;
  }
  return { rest: words.slice(i), wrapped, envDump };
}

// Reason string if writing to this path is risky, else null. Paths built from variables or
// substitutions cannot be resolved, so they count as risky; "~" and anything outside cwd too.
function writeTargetRisk(val, dynamic, cwd) {
  if (NULLISH.test(val)) return null;
  if (dynamic) return 'unresolvable write path';
  if (val.startsWith('~')) return 'writes outside project';
  return inside(path.resolve(cwd || '/', val), cwd) ? null : 'writes outside project';
}

// The allowlist: true only for known read-only or test-running commands with fully literal
// arguments. Everything else returns false and ends up MEDIUM.
function allowLow(name, args, cwd) {
  if (args.some((a) => a.dynamic)) return false;
  const plain = (a) => PLAIN.test(a.val) && !touchesSensitive(a.val) && inside(path.resolve(cwd || '/', a.val), cwd);
  const nonFlags = args.filter((a) => !isFlag(a));
  const first = args[0]?.val;
  if (name === 'pwd') return args.length === 0;
  if (name === 'ls') return nonFlags.every(plain);
  if (READERS.has(name)) {
    // --pre / --preprocessor makes ripgrep run an arbitrary program on each file.
    if (args.some((a) => a.val.startsWith('--pre'))) return false;
    // For grep/rg the first non-flag argument is the search pattern, not a path.
    const strict = name === 'grep' || name === 'rg' ? nonFlags.slice(1) : nonFlags;
    return strict.every(plain);
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) return first === 'test' || (first === 'run' && args[1]?.val === 'test');
  // Only the built-in test runner; -e/-p would run inline code.
  if (name === 'node') return args.some((a) => a.val === '--test') && !args.some((a) => ['-e', '--eval', '-p', '--print'].includes(a.val));
  if (name === 'pytest') return true;
  if (/^python3?$/.test(name)) return first === '-m' && args[1]?.val === 'pytest';
  if (name === 'go' || name === 'cargo') return first === 'test';
  if (name === 'git') {
    // --output writes a file and --ext-diff runs an external program, so both disqualify.
    if (['status', 'diff', 'log', 'show'].includes(first)) return !args.some((a) => a.val.startsWith('--output') || a.val === '--ext-diff');
    if (first === 'branch') return args.slice(1).every((a) => SAFE_BRANCH_FLAGS.has(a.val));
  }
  return false;
}

// Score one command segment (between ; | & etc.), recording findings on tracker `t`.
// Returns true only if the segment is provably LOW risk. `depth` bounds recursion into nested shells.
function scoreSegment(seg, cwd, t, depth) {
  const { rest, wrapped, envDump } = skipPrefix(seg.words);
  const all = [...seg.words, ...seg.redirects];
  const text = all.map((w) => w.val).join(' ');
  // Check every word AND every redirect target for credential files.
  for (const w of all) if (touchesSensitive(w.val)) t.bump('high', 'touches env file or key');
  if (/(^|[\s/=@:])\.env(\.[\w.-]+)?\b|\bid_(rsa|ed25519)\b|\.pem\b|\.ssh\//.test(text)) t.bump('high', 'touches env file or key');
  for (const [re, why] of HIGH) if (re.test(text)) t.bump('high', why);
  for (const [re, why] of MEDIUM) if (re.test(text)) t.bump('medium', why);
  if (envDump) t.bump('high', 'dumps secrets');
  if (!rest.length) { if (!seg.redirects.length) t.bump('medium', 'unrecognized command'); }
  const name = rest.length ? base(rest[0].val.replace(/^\\/, '')) : '';
  const args = rest.slice(1);
  const vals = args.map((a) => a.val);

  // Commands that list environment variables (which commonly hold tokens).
  if (['printenv', 'declare', 'typeset', 'compgen'].includes(name) && (name === 'printenv' || vals.some((v) => /^-[a-z]*[xpev]/.test(v)))) t.bump('high', 'dumps secrets');
  if (name === 'set' && !args.length) t.bump('high', 'dumps secrets');
  if (name === 'export' && (!args.length || vals.includes('-p'))) t.bump('high', 'dumps secrets');
  // Look at every word, not just the command name, so "sudo rm -rf" or "xargs rm -rf" is still seen.
  for (const w of seg.words) {
    if (base(w.val) === 'rm' && seg.words.some((x) => /^-[a-zA-Z]*[rRf]/.test(x.val) || x.val === '--recursive' || x.val === '--force')) t.bump('high', 'recursive or forced delete');
  }
  if (name === 'rm' && !t.reasons.includes('recursive or forced delete')) t.bump('medium', 'deletes files');
  if (name === 'find' && (vals.includes('-delete') || vals.some((v, i) => /^-exec(dir)?$/.test(v) && base(vals[i + 1] ?? '') === 'rm'))) t.bump('high', 'bulk delete');
  if (name === 'git' && vals[0] === 'clean' && vals.some((v) => /^-[a-zA-Z]*f/.test(v) || v === '--force')) t.bump('high', 'deletes untracked files');
  if (['npx', 'bunx', 'uvx'].includes(name) || (name === 'pipx' && vals[0] === 'run')) t.bump('medium', 'runs downloaded package');
  // Nested shells: the string given to -c (or eval) is itself a command, so score it recursively (max depth 3).
  if (['sh', 'bash', 'zsh', 'eval'].includes(name)) {
    const i = name === 'eval' ? 0 : vals.indexOf('-c') + 1;
    if (name === 'eval' ? args.length : i > 0) { t.bump('medium', 'runs a nested shell'); if (depth < 3) scoreText(args.slice(i).map((a) => a.val).join(' '), cwd, t, depth + 1); }
  }

  // Collect every path this segment would write to: redirects, cp/mv destinations, write-all commands, dd of=.
  const nonFlags = args.filter((a) => !isFlag(a));
  const targets = [];
  for (const r of seg.redirects) if (r.kind === 'write') targets.push(r);
  if (name === 'cp' && nonFlags.length) targets.push(nonFlags.at(-1));
  if (name === 'mv') targets.push(...nonFlags);
  if (WRITE_ALL.has(name) || name === 'rm') targets.push(...nonFlags);
  for (const a of args) if (/^of=/.test(a.val)) targets.push({ val: a.val.slice(3), dynamic: a.dynamic });
  let inProject = true;
  for (const x of targets) {
    const why = writeTargetRisk(x.val, x.dynamic, cwd);
    if (why) t.bump('high', why);
    else if (!NULLISH.test(x.val) && SENSITIVE_PATH.test(x.val)) inProject = false;
  }
  const writesOnlyRedirects = targets.every((x) => seg.redirects.includes(x));
  // LOW only if: not wrapped, no sensitive write targets, no writes except plain redirects, and the command is on the allowlist.
  if (!wrapped && inProject && writesOnlyRedirects && allowLow(name, args, cwd)) return true;
  if (rest.length) t.bump('medium', 'unrecognized command');
  return false;
}

// Score a command string: whole-text patterns, then each lexed segment, then any $(...)/backtick
// bodies hidden inside quotes. Returns true if every part was LOW.
function scoreText(cmd, cwd, t, depth = 0) {
  for (const [re, why] of WHOLE_COMMAND_HIGH) if (re.test(cmd)) t.bump('high', why);
  const { segments, error } = lex(cmd);
  // A lex error (e.g. unbalanced quote) means we cannot reason about it, so it cannot be LOW.
  if (error) t.bump('medium', 'unparseable command');
  let allLow = segments.length > 0 && !error;
  for (const seg of segments) if (!scoreSegment(seg, cwd, t, depth)) allLow = false;
  if (depth < 3) {
    // Any command substitution disqualifies LOW outright, then is scored on its own.
    for (const inner of embeddedCommands(cmd)) { allLow = false; scoreText(inner, cwd, t, depth + 1); }
  }
  return allLow;
}

// found: secret scan labels computed by the caller (sync or async).
export function scoreBash(cmd, cwd, found = [], t) {
  cmd = typeof cmd === 'string' ? cmd : String(cmd ?? '');
  cwd = typeof cwd === 'string' ? cwd : '';
  found = Array.isArray(found) ? found : [];
  // Standalone use: create a minimal tracker. The max-risk rule lives in bump (risk only ever rises).
  if (!t || typeof t.bump !== 'function') {
    t = { risk: 'low', reasons: [], bump(r, why) { this.risk = r; if (!this.reasons.includes(why)) this.reasons.push(why); } };
  }
  const low = scoreText(cmd, cwd, t);
  // Unmatched commands default to MEDIUM: LOW exists only through the allowlist.
  if (!low && t.risk === 'low') t.bump('medium', 'unrecognized command');
  for (const f of found) {
    if (f === 'secret scan failed') t.bump('medium', f);
    else t.bump('high', `secret in command: ${f}`);
  }
}

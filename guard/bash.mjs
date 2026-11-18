// Program: ashr - bash.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Scores a shell command as low, medium or high risk by lexing it into segments and checking allowlists, risky patterns, sensitive paths and write targets.
// Bash command scoring. Unmatched commands are MEDIUM. LOW comes only from the allowlist below.
// Compound commands score as the max of their parts.
// Node's path helpers, and the lexer that splits a command into words and redirects.
import path from 'node:path';
import { lex, embeddedCommands } from './lex.mjs';

// A regex for paths that usually hold secrets: .env files, ssh and cloud keys, key and certificate files, credential and history files.
export const SENSITIVE_PATH = /(^|[/@:])(\.env(\.[\w.-]+)?|id_(rsa|ed25519|ecdsa)|[\w.-]+\.(pem|key|p12|pfx)|\.ssh|\.aws|\.kube|\.npmrc|\.netrc|\.git-credentials|credentials|\.(bash|zsh)_history)(\/|$)/;
// Concrete secret-file names, used to test whether a wildcard such as .en* could match one of them.
const SENSITIVE_NAMES = ['.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', 'id_ecdsa', '.npmrc', '.netrc', '.git-credentials', 'credentials', '.ssh', '.aws', '.kube', '.zsh_history', '.bash_history']; // leakguard:allow
// Matches /proc/<pid>/environ, which exposes a process's environment variables.
const PROC_ENV = /\/proc\/[^/]+\/environ/;
// Harmless output targets such as /dev/null; writing there is not a risk.
const NULLISH = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;
// Characters that make a word a wildcard pattern.
const GLOB_CHARS = /[?*[\]]/;
// Commands that just run another command (sudo-like wrappers), which are skipped to find the real command.
const WRAPPERS = new Set(['command', 'exec', 'nohup', 'time', 'nice', 'builtin', 'xargs', 'env']);
// Commands whose non-flag arguments are all files they write or change.
const WRITE_ALL = new Set(['tee', 'touch', 'mkdir', 'rmdir', 'ln', 'truncate', 'install']);
// Read-only commands that may be allowed when they only touch plain project files.
const READERS = new Set(['cat', 'head', 'tail', 'wc', 'grep', 'rg']);
// Safe-looking plain words: letters, digits and a few punctuation marks, no shell tricks.
const PLAIN = /^[\w.@+,:=/-]+$/;
// Flags that make "git branch" read-only.
const SAFE_BRANCH_FLAGS = new Set(['-a', '-r', '-v', '-vv', '--list', '--show-current', '--all', '--remotes']);

// Patterns checked against the whole command string (not one segment). Each pair is a regex and the reason shown to the user.
const WHOLE_COMMAND_HIGH = [
  [/\bgit\s+push\b.*(--force\b|--force-with-lease|\s-f\b)/, 'force push'],
  [/\b(curl|wget)\b[^|;\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'pipes download into a shell'],
  [/\b(base64|openssl|xxd)\b[^|;\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'obfuscated decoded pipe into shell'],
  [/\b((ba|z|da)?sh|source|\.)\s*<\s*\(/, 'process substitution into a shell'],
  [/\/dev\/(tcp|udp)\/|\b(nc|ncat|netcat)\b.*-e\b|\bsocat\b.*(exec|system):/i, 'reverse shell / network socket redirect'],
];

// Patterns that make a command high risk.
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
// Patterns that make a command medium risk.
const MEDIUM = [
  [/\b(npm|pnpm|yarn|bun)\s+(install|i|add)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bcargo\s+(install|add)\b|\bgem\s+install\b/, 'package install'],
  [/\bgit\s+push\b/, 'git push'],
  [/\b(curl|wget|ssh|scp|rsync|nc|ncat)\b|https?:\/\//, 'network call'],
  [/\bgit\s+(rebase|merge)\b/, 'rewrites git state'],
];

// The file-name part of a path, so "/usr/bin/rm" and "rm" are treated alike.
const base = (s) => path.basename(String(s));

// True when abs is inside the working folder cwd (or when there is no cwd to compare against).
function inside(abs, cwd) {
  if (!cwd) return true;
  const rel = path.relative(path.resolve(cwd), abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Turn a simple shell wildcard (* ? [!..]) into a regular expression; returns null if it is not valid.
function globRe(g) {
  const s = g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\[!/g, '[^');
  try { return new RegExp(`^${s}$`); } catch { return null; }
}

// Check a word against the sensitive-path rules, including values after = or : and wildcard guesses.
// True when the word is, or could expand to, an env file or key file.
export function touchesSensitive(val) {
  if (!val) return false;
  const raw = String(val).replace(/^@+/, '');
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

// A word is a flag if it starts with a dash and is longer than one character.
const isFlag = (w) => w.val.startsWith('-') && w.val.length > 1;

// Skip leading VAR=value assignments and wrapper commands (and their flags). Returns the remaining words, whether a wrapper was seen, and whether a bare "env" would dump the environment.
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

// Decide whether a write target is risky: null means fine, otherwise the reason (unresolvable path or outside the project).
function writeTargetRisk(val, dynamic, cwd) {
  if (NULLISH.test(val)) return null;
  if (dynamic) return 'unresolvable write path';
  if (val.startsWith('~')) return 'writes outside project';
  return inside(path.resolve(cwd || '/', val), cwd) ? null : 'writes outside project';
}

// The allowlist: true only for known read-only or test commands whose arguments are plain files inside the project. Anything unknown returns false.
function allowLow(name, args, cwd) {
  if (args.some((a) => a.dynamic)) return false;
  // A plain argument is simple text, not sensitive and inside the project.
  const plain = (a) => PLAIN.test(a.val) && !touchesSensitive(a.val) && inside(path.resolve(cwd || '/', a.val), cwd);
  const nonFlags = args.filter((a) => !isFlag(a));
  const first = args[0]?.val;
  if (name === 'pwd') return args.length === 0;
  if (name === 'ls') return nonFlags.every(plain);
  if (READERS.has(name)) {
    if (args.some((a) => a.val.startsWith('--pre'))) return false;
    const strict = name === 'grep' || name === 'rg' ? nonFlags.slice(1) : nonFlags;
    return strict.every(plain);
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) return first === 'test' || (first === 'run' && args[1]?.val === 'test');
  if (name === 'node') return args.some((a) => a.val === '--test') && !args.some((a) => ['-e', '--eval', '-p', '--print'].includes(a.val));
  if (name === 'pytest') return true;
  if (/^python3?$/.test(name)) return first === '-m' && args[1]?.val === 'pytest';
  if (name === 'go' || name === 'cargo') return first === 'test';
  if (name === 'git') {
    if (['status', 'diff', 'log', 'show'].includes(first)) return !args.some((a) => a.val.startsWith('--output') || a.val === '--ext-diff');
    if (first === 'branch') return args.slice(1).every((a) => SAFE_BRANCH_FLAGS.has(a.val));
  }
  return false;
}

// Score one command segment, updating the tracker t. Returns true when the segment qualifies as low risk.
function scoreSegment(seg, cwd, t, depth) {
  // Strip wrappers, then collect all words and redirects to test patterns against.
  const { rest, wrapped, envDump } = skipPrefix(seg.words);
  const all = [...seg.words, ...seg.redirects];
  const text = all.map((w) => w.val).join(' ');
  // Check every word for sensitive paths and test the HIGH and MEDIUM patterns on the joined text.
  for (const w of all) if (touchesSensitive(w.val)) t.bump('high', 'touches env file or key');
  if (/(^|[\s/=@:])\.env(\.[\w.-]+)?\b|\bid_(rsa|ed25519)\b|\.pem\b|\.ssh\//.test(text)) t.bump('high', 'touches env file or key');
  for (const [re, why] of HIGH) if (re.test(text)) t.bump('high', why);
  for (const [re, why] of MEDIUM) if (re.test(text)) t.bump('medium', why);
  if (envDump) t.bump('high', 'dumps secrets');
  if (!rest.length) { if (!seg.redirects.length) t.bump('medium', 'unrecognized command'); }
  // The command name and its arguments.
  const name = rest.length ? base(rest[0].val.replace(/^\\/, '')) : '';
  const args = rest.slice(1);
  const vals = args.map((a) => a.val);

  // Commands that print environment or shell variables count as dumping secrets.
  if (['printenv', 'declare', 'typeset', 'compgen'].includes(name) && (name === 'printenv' || vals.some((v) => /^-[a-z]*[xpev]/.test(v)))) t.bump('high', 'dumps secrets');
  if (name === 'set' && !args.length) t.bump('high', 'dumps secrets');
  if (name === 'export' && (!args.length || vals.includes('-p'))) t.bump('high', 'dumps secrets');
  // rm with recursive or force flags is high risk; plain rm is medium.
  for (const w of seg.words) {
    if (base(w.val) === 'rm' && seg.words.some((x) => /^-[a-zA-Z]*[rRf]/.test(x.val) || x.val === '--recursive' || x.val === '--force')) t.bump('high', 'recursive or forced delete');
  }
  if (name === 'rm' && !t.reasons.includes('recursive or forced delete')) t.bump('medium', 'deletes files');
  // find with -delete or -exec rm is a bulk delete; git clean with force deletes untracked files; npx-style runners download code.
  if (name === 'find' && (vals.includes('-delete') || vals.some((v, i) => /^-exec(dir)?$/.test(v) && base(vals[i + 1] ?? '') === 'rm'))) t.bump('high', 'bulk delete');
  if (name === 'git' && vals[0] === 'clean' && vals.some((v) => /^-[a-zA-Z]*f/.test(v) || v === '--force')) t.bump('high', 'deletes untracked files');
  if (['npx', 'bunx', 'uvx'].includes(name) || (name === 'pipx' && vals[0] === 'run')) t.bump('medium', 'runs downloaded package');
  // For sh -c, bash -c and eval: mark as medium and score the inner text too (depth limited to 3).
  if (['sh', 'bash', 'zsh', 'eval'].includes(name)) {
    const i = name === 'eval' ? 0 : vals.indexOf('-c') + 1;
    if (name === 'eval' ? args.length : i > 0) { t.bump('medium', 'runs a nested shell'); if (depth < 3) scoreText(args.slice(i).map((a) => a.val).join(' '), cwd, t, depth + 1); }
  }

  // Collect every place this segment writes: redirects, copy and move targets, and files named by write commands or of= options.
  const nonFlags = args.filter((a) => !isFlag(a));
  const targets = [];
  for (const r of seg.redirects) if (r.kind === 'write') targets.push(r);
  if (name === 'cp' && nonFlags.length) targets.push(nonFlags.at(-1));
  if (name === 'mv') targets.push(...nonFlags);
  if (WRITE_ALL.has(name) || name === 'rm') targets.push(...nonFlags);
  for (const a of args) if (/^of=/.test(a.val)) targets.push({ val: a.val.slice(3), dynamic: a.dynamic });
  // Check each target; risky ones add reasons. A sensitive path flips inProject to false.
  let inProject = true;
  for (const x of targets) {
    const why = writeTargetRisk(x.val, x.dynamic, cwd);
    if (why) t.bump('high', why);
    else if (!NULLISH.test(x.val) && SENSITIVE_PATH.test(x.val)) inProject = false;
  }
  // Low risk only if there is no wrapper, writes stay in the project, only redirects write, and the command is on the allowlist.
  const writesOnlyRedirects = targets.every((x) => seg.redirects.includes(x));
  if (!wrapped && inProject && writesOnlyRedirects && allowLow(name, args, cwd)) return true;
  if (rest.length) t.bump('medium', 'unrecognized command');
  return false;
}

// Score a command string: whole-command patterns, then each lexed segment, then commands embedded inside quotes. Returns true if everything was low risk.
function scoreText(cmd, cwd, t, depth = 0) {
  for (const [re, why] of WHOLE_COMMAND_HIGH) if (re.test(cmd)) t.bump('high', why);
  const { segments, error } = lex(cmd);
  if (error) t.bump('medium', 'unparseable command');
  let allLow = segments.length > 0 && !error;
  for (const seg of segments) if (!scoreSegment(seg, cwd, t, depth)) allLow = false;
  if (depth < 3) {
    for (const inner of embeddedCommands(cmd)) { allLow = false; scoreText(inner, cwd, t, depth + 1); }
  }
  return allLow;
}

// The public entry point: score a command and record risk and reasons on the tracker t.
// found: secret scan labels computed by the caller (sync or async).
// Normalise the inputs, create a default tracker if none was given, score the text and add any secret-scan findings (high), or a medium reason if the scan itself failed.
export function scoreBash(cmd, cwd, found = [], t) {
  cmd = typeof cmd === 'string' ? cmd : String(cmd ?? '');
  cwd = typeof cwd === 'string' ? cwd : '';
  found = Array.isArray(found) ? found : [];
  if (!t || typeof t.bump !== 'function') {
    t = { risk: 'low', reasons: [], bump(r, why) { this.risk = r; if (!this.reasons.includes(why)) this.reasons.push(why); } };
  }
  const low = scoreText(cmd, cwd, t);
  if (!low && t.risk === 'low') t.bump('medium', 'unrecognized command');
  for (const f of found) {
    if (f === 'secret scan failed') t.bump('medium', f);
    else t.bump('high', `secret in command: ${f}`);
  }
}

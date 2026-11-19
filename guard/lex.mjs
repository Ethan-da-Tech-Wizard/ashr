// Quote-aware shell lexer for the guard. Splits a command into segments of words and redirects.
// It never runs anything. Over-approximates: any doubt becomes a flag the scorer treats as risky.
//
// How it fits: guard/bash.mjs calls lex() to turn the raw command text into structured pieces it
//   can inspect (which program, which arguments, which files are redirected to) instead of using
//   regexes on one big string, which attackers can sidestep with quoting, e.g. `c'a't .env`.
//   embeddedCommands() finds $(...) and backtick bodies that run even inside double quotes.
// Why hand-written: a real shell parser is huge; this handles the constructs that matter for
//   risk (quotes, escapes, operators, redirects, substitutions, comments) and flags the rest.
// Known limits: no here-doc bodies, arithmetic, brace expansion or nested substitutions; these
//   either end up as 'dynamic' words or are only caught approximately, which makes the scorer
//   stricter, not looser. Test: test/guard.test.mjs and test/fuzz.test.mjs (random command fuzzing).

// Characters that end a command segment.
/**
 * @param {string} c - single character.
 * @returns {boolean} true for `; | & ( ) ` ` and newline. Note '&' is included so `a & b` and
 *   `a && b` both split (the redirect forms `&>` and `>&` are handled before this is reached).
 */
const isOp = (c) => c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '`' || c === '\n';

// Returns { segments: [{ words: [{val, dynamic, quoted}], redirects: [{kind, val, dynamic}] }], error }.
/**
 * @param {string} cmd - shell command text (non-strings are coerced).
 * @returns {{segments: Array<{words: Array<{val: string, dynamic: boolean, quoted: boolean}>,
 *   redirects: Array<{kind: 'write'|'read', val: string, dynamic: boolean}>}>, error: boolean}}
 *   `dynamic` = the word contains a $expansion or backtick the shell would evaluate; `quoted` =
 *   any part was quoted or escaped (so it is not a bare number or flag). `error` = unbalanced
 *   quote, in which case parsing stops and the scorer refuses to call the command LOW.
 */
export function lex(cmd) {
  cmd = typeof cmd === 'string' ? cmd : String(cmd ?? '');
  const segments = [];
  // Parser state: `seg` is the command being built, `tok` the word being built, `pending` a
  // redirect operator that still needs its target word.
  let seg = { words: [], redirects: [] };
  let tok = null; // { val, dynamic, quoted }
  let pending = null; // redirect kind waiting for its target word
  let error = false;

  // Finish the current segment (command) and start a new one.
  const endSeg = () => {
    if (seg.words.length || seg.redirects.length) segments.push(seg);
    seg = { words: [], redirects: [] };
    pending = null;
  };
  // Finish the current word: it becomes a redirect target if one is pending, else a command word.
  const pushTok = () => {
    if (!tok) return;
    if (pending) {
      if (pending !== 'ignore') seg.redirects.push({ kind: pending, val: tok.val, dynamic: tok.dynamic });
      pending = null;
    } else seg.words.push(tok);
    tok = null;
  };
  // Append text to the current word. `dynamic` marks content the shell would expand ($VAR, $(..)), which we cannot resolve statically.
  const add = (s, flags = {}) => {
    tok ??= { val: '', dynamic: false, quoted: false };
    tok.val += s;
    if (flags.quoted) tok.quoted = true;
    if (flags.dynamic) tok.dynamic = true;
  };

  // Single left-to-right pass; each branch below handles one kind of shell syntax.
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const n = cmd[i + 1];
    // Whitespace ends the current word (the loop is deliberately a state machine, one char per step).
    if (c === ' ' || c === '\t' || c === '\r') { pushTok(); continue; }
    // A '#' at the start of a word begins a comment to end of line.
    if (c === '#' && !tok) { while (i < cmd.length && cmd[i] !== '\n') i++; i--; continue; }
    // Backslash escapes the next character (backslash-newline is a line continuation).
    if (c === '\\') { if (n !== undefined && n !== '\n') add(n, { quoted: true }); i++; continue; }
    // Single quotes: literal text, nothing expands. An unterminated quote is a lex error.
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j < 0) { error = true; break; }
      add(cmd.slice(i + 1, j), { quoted: true });
      i = j; continue;
    }
    // Double quotes: backslash only escapes " \ $ and backtick; $ or backtick inside makes the word dynamic.
    if (c === '"') {
      let j = i + 1; let s = ''; let dyn = false; let closed = false;
      for (; j < cmd.length; j++) {
        const d = cmd[j];
        if (d === '\\' && j + 1 < cmd.length) {
          const e = cmd[j + 1];
          s += '"\\$`'.includes(e) ? e : d + e; j++; continue;
        }
        if (d === '"') { closed = true; break; }
        if (d === '$' || d === '`') dyn = true;
        s += d;
      }
      if (!closed) { error = true; break; }
      add(s, { quoted: true, dynamic: dyn });
      i = j; continue;
    }
    // "$(" starts a command substitution: end the segment so the inner command is scored separately. A bare "$" marks the word dynamic.
    if (c === '$') {
      if (n === '(') { pushTok(); endSeg(); i++; continue; }
      add(c, { dynamic: true }); continue;
    }
    // Redirections. A bare digit before it is a file descriptor (2>file) and is dropped.
    if (c === '>' || c === '<') {
      const fd = tok && !tok.quoted && /^\d+$/.test(tok.val);
      if (fd) tok = null; else pushTok();
      let op = c; let j = i;
      while (cmd[j + 1] === c) { op += c; j++; }
      if (c === '>' && cmd[j + 1] === '|') j++;
      // fd duplication such as 2>&1 does not name a file, so it is skipped.
      if (c === '>' && cmd[j + 1] === '&' && /[\d-]/.test(cmd[j + 2] ?? '')) {
        j += 2; while (/\d/.test(cmd[j + 1] ?? '')) j++;
        i = j; continue; // fd duplication like 2>&1
      }
      i = j;
      if (cmd[i + 1] === '(') continue; // process substitution: the paren ends the segment
      // The next word is the target: '>' writes, '<' reads, '<<' (heredoc) is ignored.
      pending = c === '>' ? 'write' : op.length > 1 ? 'ignore' : 'read';
      continue;
    }
    // bash's "&>file" (stdout and stderr to a file).
    if (c === '&' && n === '>') {
      pushTok(); i += cmd[i + 2] === '>' ? 2 : 1; pending = 'write'; continue;
    }
    // Any other operator character ends the word and the command (so `a; b | c` is 3 commands,
    // each scored on its own).
    if (isOp(c)) { pushTok(); endSeg(); continue; }
    // Ordinary character: part of the current word.
    add(c);
  }
  pushTok(); endSeg();
  return { segments, error };
}

// Backtick and $(...) bodies sitting inside double quotes still run. Return their text.
// Regex extraction is a deliberate over-approximation: it ignores nesting, but any doubt only makes the scorer stricter.
/**
 * @param {string} cmd - full command text.
 * @returns {string[]} the text inside each `$( ... )` (no inner parentheses) and each backtick
 *   pair, for the scorer to evaluate as commands in their own right.
 */
export function embeddedCommands(cmd) {
  const str = typeof cmd === 'string' ? cmd : String(cmd ?? '');
  return [...str.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)].map((m) => m[1] ?? m[2]);
}

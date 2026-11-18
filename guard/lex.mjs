// Program: ashr - lex.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: A small quote-aware shell lexer for the guard that splits a command into segments of words and redirects without running anything.
// Quote-aware shell lexer for the guard. Splits a command into segments of words and redirects.
// It never runs anything. Over-approximates: any doubt becomes a flag the scorer treats as risky.

// Characters that end a command segment: ; | & ( ) backtick and newline.
const isOp = (c) => c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '`' || c === '\n';

// Returns { segments: [{ words: [{val, dynamic, quoted}], redirects: [{kind, val, dynamic}] }], error }.
// Split a command string into segments.
// @param {string} cmd the shell command.
// @returns {{segments: Array, error: boolean}} segments with words and redirects; error is true if quotes are unbalanced.
export function lex(cmd) {
  cmd = typeof cmd === 'string' ? cmd : String(cmd ?? '');
  // segments collects finished segments; seg is the one being built; tok is the word being built; pending is a redirect waiting for its target word.
  const segments = [];
  let seg = { words: [], redirects: [] };
  let tok = null; // { val, dynamic, quoted }
  let pending = null; // redirect kind waiting for its target word
  let error = false;

  // Finish the current segment (if not empty) and start a new one.
  const endSeg = () => {
    if (seg.words.length || seg.redirects.length) segments.push(seg);
    seg = { words: [], redirects: [] };
    pending = null;
  };
  // Finish the current word: it becomes either the target of a pending redirect or a normal word.
  const pushTok = () => {
    if (!tok) return;
    if (pending) {
      if (pending !== 'ignore') seg.redirects.push({ kind: pending, val: tok.val, dynamic: tok.dynamic });
      pending = null;
    } else seg.words.push(tok);
    tok = null;
  };
  // Append text to the current word, remembering if any part was quoted or dynamic (contains $ or a backtick).
  const add = (s, flags = {}) => {
    tok ??= { val: '', dynamic: false, quoted: false };
    tok.val += s;
    if (flags.quoted) tok.quoted = true;
    if (flags.dynamic) tok.dynamic = true;
  };

  // Walk through the command one character at a time.
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const n = cmd[i + 1];
    // Whitespace ends a word. A # at the start of a word starts a comment to the end of the line.
    if (c === ' ' || c === '\t' || c === '\r') { pushTok(); continue; }
    if (c === '#' && !tok) { while (i < cmd.length && cmd[i] !== '\n') i++; i--; continue; }
    // A backslash escapes the next character.
    if (c === '\\') { if (n !== undefined && n !== '\n') add(n, { quoted: true }); i++; continue; }
    // Single quotes: everything up to the next single quote is literal. No closing quote is an error.
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j < 0) { error = true; break; }
      add(cmd.slice(i + 1, j), { quoted: true });
      i = j; continue;
    }
    // Double quotes: handle escapes, note $ and backtick as dynamic, and require a closing quote.
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
    // $( starts a command substitution, which ends the current segment; a bare $ marks the word as dynamic.
    if (c === '$') {
      if (n === '(') { pushTok(); endSeg(); i++; continue; }
      add(c, { dynamic: true }); continue;
    }
    // Redirect characters. A number before them (like 2>) is a file descriptor; >& with a number is fd duplication and is ignored; the next word becomes a write, read or ignored (heredoc) target.
    if (c === '>' || c === '<') {
      const fd = tok && !tok.quoted && /^\d+$/.test(tok.val);
      if (fd) tok = null; else pushTok();
      let op = c; let j = i;
      while (cmd[j + 1] === c) { op += c; j++; }
      if (c === '>' && cmd[j + 1] === '|') j++;
      if (c === '>' && cmd[j + 1] === '&' && /[\d-]/.test(cmd[j + 2] ?? '')) {
        j += 2; while (/\d/.test(cmd[j + 1] ?? '')) j++;
        i = j; continue; // fd duplication like 2>&1
      }
      i = j;
      if (cmd[i + 1] === '(') continue; // process substitution: the paren ends the segment
      pending = c === '>' ? 'write' : op.length > 1 ? 'ignore' : 'read';
      continue;
    }
    // &> redirects both output streams to a file.
    if (c === '&' && n === '>') {
      pushTok(); i += cmd[i + 2] === '>' ? 2 : 1; pending = 'write'; continue;
    }
    // An operator ends the word and the segment.
    if (isOp(c)) { pushTok(); endSeg(); continue; }
    add(c);
  }
  // Flush whatever is left at the end of the string.
  pushTok(); endSeg();
  return { segments, error };
}

// Find commands hidden inside $(...) or backticks, even within double quotes, so they can be scored as well.
// Backtick and $(...) bodies sitting inside double quotes still run. Return their text.
// Return the text of every $(...) or backtick body found in cmd.
export function embeddedCommands(cmd) {
  const str = typeof cmd === 'string' ? cmd : String(cmd ?? '');
  return [...str.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)].map((m) => m[1] ?? m[2]);
}

// Quote-aware shell lexer for the guard. Splits a command into segments of words and redirects.
// It never runs anything. Over-approximates: any doubt becomes a flag the scorer treats as risky.

const isOp = (c) => c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '`' || c === '\n';

// Returns { segments: [{ words: [{val, dynamic, quoted}], redirects: [{kind, val, dynamic}] }], error }.
export function lex(cmd) {
  cmd = typeof cmd === 'string' ? cmd : String(cmd ?? '');
  const segments = [];
  let seg = { words: [], redirects: [] };
  let tok = null; // { val, dynamic, quoted }
  let pending = null; // redirect kind waiting for its target word
  let error = false;

  const endSeg = () => {
    if (seg.words.length || seg.redirects.length) segments.push(seg);
    seg = { words: [], redirects: [] };
    pending = null;
  };
  const pushTok = () => {
    if (!tok) return;
    if (pending) {
      if (pending !== 'ignore') seg.redirects.push({ kind: pending, val: tok.val, dynamic: tok.dynamic });
      pending = null;
    } else seg.words.push(tok);
    tok = null;
  };
  const add = (s, flags = {}) => {
    tok ??= { val: '', dynamic: false, quoted: false };
    tok.val += s;
    if (flags.quoted) tok.quoted = true;
    if (flags.dynamic) tok.dynamic = true;
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const n = cmd[i + 1];
    if (c === ' ' || c === '\t' || c === '\r') { pushTok(); continue; }
    if (c === '#' && !tok) { while (i < cmd.length && cmd[i] !== '\n') i++; i--; continue; }
    if (c === '\\') { if (n !== undefined && n !== '\n') add(n, { quoted: true }); i++; continue; }
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j < 0) { error = true; break; }
      add(cmd.slice(i + 1, j), { quoted: true });
      i = j; continue;
    }
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
    if (c === '$') {
      if (n === '(') { pushTok(); endSeg(); i++; continue; }
      add(c, { dynamic: true }); continue;
    }
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
    if (c === '&' && n === '>') {
      pushTok(); i += cmd[i + 2] === '>' ? 2 : 1; pending = 'write'; continue;
    }
    if (isOp(c)) { pushTok(); endSeg(); continue; }
    add(c);
  }
  pushTok(); endSeg();
  return { segments, error };
}

// Backtick and $(...) bodies sitting inside double quotes still run. Return their text.
export function embeddedCommands(cmd) {
  const str = typeof cmd === 'string' ? cmd : String(cmd ?? '');
  return [...str.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)].map((m) => m[1] ?? m[2]);
}

// Lightweight Luau heuristics. These are NOT a parser or compiler: they spot common
// structural slips and well-known deprecated patterns. Used by the Code Playground
// and by the knowledge validator for code blocks.

export type Finding = { line: number; severity: 'error' | 'warning' | 'info'; message: string };

type Tok = { v: string; line: number; sym?: boolean };

/** Blank out comments and string contents (keeping newlines) so keywords inside them are ignored. */
export function stripLuau(src: string, keepStrings = false): string {
  let out = '';
  let i = 0;
  const n = src.length;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = src[i];
    if (c === '-' && src[i + 1] === '-') {
      const m = /^--\[(=*)\[/.exec(src.slice(i, i + 40));
      if (m) {
        const close = ']' + m[1] + ']';
        const end = src.indexOf(close, i + m[0].length);
        const stop = end === -1 ? n : end + close.length;
        out += blank(src.slice(i, stop)); i = stop; continue;
      }
      const nl = src.indexOf('\n', i);
      const stop = nl === -1 ? n : nl;
      out += blank(src.slice(i, stop)); i = stop; continue;
    }
    if (c === '[') {
      const m = /^\[(=*)\[/.exec(src.slice(i, i + 40));
      if (m) {
        const close = ']' + m[1] + ']';
        const end = src.indexOf(close, i + m[0].length);
        const stop = end === -1 ? n : end + close.length;
        out += blank(src.slice(i, stop)); i = stop; continue;
      }
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      const stop = Math.min(j + 1, n);
      out += keepStrings ? src.slice(i, stop) : c + blank(src.slice(i + 1, stop - 1)) + (src[stop - 1] === c ? c : ''); i = stop; continue;
    }
    out += c; i++;
  }
  return out;
}

function tokenize(clean: string): Tok[] {
  const toks: Tok[] = [];
  const re = /[A-Za-z_][A-Za-z_0-9]*|[=,({+\-*\/%^<>~.]|\n/g;
  let line = 1; let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    if (m[0] === '\n') { line++; continue; }
    toks.push({ v: m[0], line, sym: !/^[A-Za-z_]/.test(m[0]) });
  }
  return toks;
}

/** Check that function/if/do blocks and repeat/until pairs are balanced. */
export function checkBlocks(src: string): Finding[] {
  const toks = tokenize(stripLuau(src));
  const stack: { kw: string; line: number }[] = [];
  const findings: Finding[] = [];
  const exprPrev = new Set(['=', ',', '(', '{', '+', '-', '*', '/', '%', '^', '<', '>', '~', '.', 'return', 'and', 'or', 'not']);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.sym) continue;
    if (t.v === 'function' || t.v === 'do' || t.v === 'repeat') stack.push({ kw: t.v, line: t.line });
    else if (t.v === 'if') {
      const prev = toks[i - 1];
      const isExpr = prev && prev.line === t.line && exprPrev.has(prev.v); // Luau if-expression has no `end`
      if (!isExpr) stack.push({ kw: 'if', line: t.line });
    } else if (t.v === 'end') {
      const top = stack.pop();
      if (!top || top.kw === 'repeat') findings.push({ line: t.line, severity: 'error', message: top ? `'end' found where 'until' was expected (repeat opened on line ${top.line}).` : "Unexpected 'end' with no open block." });
    } else if (t.v === 'until') {
      const top = stack.pop();
      if (!top || top.kw !== 'repeat') findings.push({ line: t.line, severity: 'error', message: "'until' without a matching 'repeat'." });
    }
  }
  for (const open of stack) findings.push({ line: open.line, severity: 'error', message: `'${open.kw}' opened here is never closed with '${open.kw === 'repeat' ? 'until' : 'end'}'.` });
  return findings;
}

const HINTS: { re: RegExp; severity: Finding['severity']; message: string }[] = [
  { re: /(^|[^.\w:])wait\s*\(/, severity: 'warning', message: 'wait() is deprecated. Prefer task.wait().' },
  { re: /(^|[^.\w:])spawn\s*\(/, severity: 'warning', message: 'spawn() is deprecated. Prefer task.spawn() or task.defer().' },
  { re: /(^|[^.\w:])delay\s*\(/, severity: 'warning', message: 'delay() is deprecated. Prefer task.delay().' },
  { re: /:connect\s*\(/, severity: 'warning', message: 'Lowercase :connect is deprecated. Use :Connect().' },
  { re: /Instance\.new\(\s*["'][A-Za-z]+["']\s*,/, severity: 'warning', message: 'Passing a parent to Instance.new is discouraged. Set .Parent last instead.' },
  { re: /\bgame\.(Players|Workspace|ReplicatedStorage|ServerStorage|Lighting|TweenService|RunService)\b/, severity: 'info', message: 'Consider game:GetService("...") to fetch services reliably.' },
  { re: /LoadAnimation\s*\(/, severity: 'info', message: 'Load animations through an Animator (animator:LoadAnimation), not directly on a Humanoid.' }
];

/** Structural and deprecation hints. Heuristic only: it cannot prove code is correct or incorrect. */
export function lintLuau(src: string): Finding[] {
  const findings = checkBlocks(src);
  const clean = stripLuau(src, true).split('\n');
  clean.forEach((text, idx) => {
    for (const h of HINTS) if (h.re.test(text)) findings.push({ line: idx + 1, severity: h.severity, message: h.message });
  });
  return findings.sort((a, b) => a.line - b.line);
}

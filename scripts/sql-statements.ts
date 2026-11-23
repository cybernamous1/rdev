// Trigger-aware SQL statement splitter. Used by tests and by `npm run db:statements`.
// Handy if a dashboard console cannot take a whole file: run the listed statements one at a time.
//   npm run db:statements -- database/init.sql [--out <dir>]   (lists statements; --out writes numbered files)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function splitStatements(sql: string): string[] {
  const out: string[] = []; let cur = ''; let depth = 0; let i = 0;
  const flush = () => { const t = cur.trim(); if (t && t.replace(/--[^\n]*/g, '').trim()) out.push(t); cur = ''; };
  while (i < sql.length) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') { const nl = sql.indexOf('\n', i); const end = nl < 0 ? sql.length : nl; cur += sql.slice(i, end); i = end; continue; }
    if (c === '/' && sql[i + 1] === '*') { const end = sql.indexOf('*/', i + 2); const stop = end < 0 ? sql.length : end + 2; cur += sql.slice(i, stop); i = stop; continue; }
    if (c === "'" || c === '"' || c === '`') { let j = i + 1; while (j < sql.length) { if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; } j++; } cur += sql.slice(i, j + 1); i = j + 1; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
      const w = sql.slice(i, j).toUpperCase();
      if (w === 'BEGIN' || w === 'CASE') depth++; else if (w === 'END' && depth > 0) depth--;
      cur += sql.slice(i, j); i = j; continue;
    }
    if (c === ';' && depth === 0) { cur += ';'; flush(); i++; continue; }
    cur += c; i++;
  }
  flush();
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, flag, dir] = process.argv.slice(2);
  if (!file) { console.error('Usage: db:statements <file.sql> [--out <dir>]'); process.exit(2); }
  const stmts = splitStatements(readFileSync(file, 'utf8'));
  const sizes = stmts.map((s) => Buffer.byteLength(s));
  console.log(`${stmts.length} statements, largest ${Math.max(...sizes)} bytes.`);
  if (flag === '--out' && dir) { mkdirSync(dir, { recursive: true }); stmts.forEach((s, i) => writeFileSync(join(dir, `${String(i + 1).padStart(4, '0')}.sql`), s + '\n')); console.log(`Wrote ${stmts.length} files to ${dir}`); }
  else stmts.forEach((s, i) => console.log(`${String(i + 1).padStart(4, '0')}  ${sizes[i]}B  ${s.split('\n').find((l) => l.trim() && !l.trim().startsWith('--'))?.slice(0, 90)}`));
}

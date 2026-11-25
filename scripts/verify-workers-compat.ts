// Static Workers-compatibility check of the v0.5.0 engine sources. LOCAL ONLY: it proves the code uses no Node-only or
// dynamic-code APIs; it does NOT replace running the project under wrangler/workerd.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['knowledge/engine', 'worker/discovery-v5-api.ts', 'worker/discovery-v5-store.ts'];
const rules: [RegExp, string][] = [
  [/from\s+['"]node:/, 'node: import'], [/\brequire\s*\(/, 'require()'], [/\bprocess\./, 'process global'], [/\bBuffer\b/, 'Buffer'],
  [/\beval\s*\(/, 'eval()'], [/new\s+Function\s*\(/, 'new Function()'], [/\bimport\s*\(\s*[^'"\s)]/, 'dynamic import of a computed specifier'],
  [/\bfrom\s+['"](?:fs|path|child_process|net|http|https|os|crypto|zlib|stream)['"]/, 'Node built-in import'], [/\blocalStorage\b|\bdocument\./, 'browser-only API'],
  [/WebAssembly\.(compile|instantiate)\s*\(/, 'runtime WebAssembly compilation (blocked in Workers)']
];
const files: string[] = [];
const walk = (p: string) => { const s = statSync(p); if (s.isDirectory()) for (const f of readdirSync(p)) walk(join(p, f)); else if (p.endsWith('.ts')) files.push(p); };
for (const t of targets) walk(join(root, t));
let bad = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8').split('\n');
  src.forEach((line, i) => { const code = line.replace(/\/\/.*$/, '').replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''"); for (const [re, label] of rules) if (re.test(label === 'node: import' || label === 'Node built-in import' || label === 'dynamic import of a computed specifier' ? line.replace(/\/\/.*$/, '') : code)) { console.error(`${f.slice(root.length + 1)}:${i + 1}: ${label}`); bad++; } });
}
console.log(bad ? `${bad} Workers-compatibility problem(s).` : `${files.length} file(s) use only web-standard APIs (static check; not a workerd run).`);
process.exit(bad ? 1 : 0);

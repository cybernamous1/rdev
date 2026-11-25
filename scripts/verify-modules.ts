// Verifies every modules/<id>/module.json (see modules/README.md). Exit code 1 if any module is incomplete. With no modules it passes.
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../knowledge/engine/runtime/manifest.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'modules');
let failed = 0; let count = 0;
for (const name of existsSync(root) ? readdirSync(root) : []) {
  const dir = join(root, name); if (!statSync(dir).isDirectory()) continue;
  count++; const mf = join(dir, 'module.json');
  if (!existsSync(mf)) { console.error(`${name}: module.json missing`); failed++; continue; }
  let manifest; try { manifest = JSON.parse(readFileSync(mf, 'utf8')); } catch { console.error(`${name}: module.json is not valid JSON`); failed++; continue; }
  const errors = validateManifest(manifest, (rel) => existsSync(join(dir, rel)));
  if (errors.length) { failed++; console.error(`${name}: NOT VERIFIED\n  - ${errors.join('\n  - ')}`); } else console.log(`${name}: manifest complete`);
}
console.log(count === 0 ? 'No optional-language modules present (TypeScript only).' : `${count - failed}/${count} module(s) complete.`);
process.exit(failed ? 1 : 0);

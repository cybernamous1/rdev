import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers/sqlite.ts';

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

test('version is 0.3.0 everywhere it is declared', () => {
  assert.equal(pkg.version, '0.3.0');
  assert.match(read('worker/public-api.ts'), /API_VERSION = '0\.3\.0'/);
  assert.match(read('src/pages/Personal.tsx'), /0\.3\.0/);
  assert.match(read('public/sw.js'), /rdev-academy-v3/);
  assert.match(read('knowledge/acquire.ts'), /RDevAcademyKnowledgeBot\/0\.3/);
  assert.match(read('database/init.sql'), /schema_version','0\.3\.0'/);
});

test('intended stack is restored and unnecessary dependencies stay out', () => {
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const d of ['react', 'react-dom', 'hono', 'vite', '@vitejs/plugin-react', 'typescript', 'tailwindcss', '@tailwindcss/vite', '@cloudflare/vite-plugin', '@cloudflare/workers-types', 'wrangler']) assert.ok(all[d], d);
  for (const d of ['lucide-react', '@cloudflare/kv-asset-handler']) assert.ok(!all[d], d + ' must not be a dependency');
  const vite = read('vite.config.ts'); for (const s of ['react()', 'tailwindcss()', 'cloudflare()']) assert.ok(vite.includes(s), s);
  const w = read('wrangler.jsonc'); assert.ok(w.includes('nodejs_compat') && w.includes('"DB"') && w.includes('single-page-application') && w.includes('worker/index.ts'));
  assert.ok(!/kv_namespaces|durable_objects|r2_buckets/.test(w), 'no KV / Durable Objects / R2');
  assert.match(read('src/styles.css'), /tailwindcss\/(theme|utilities)\.css/);
  assert.match(read('worker/index.ts'), /from 'hono'/);
});

test('learner principles: no accounts, no external AI services, no admin implementation yet', () => {
  const files = ['worker/index.ts', 'worker/public-api.ts', 'src/App.tsx', 'src/services/initialize.ts', 'src/services/platform.ts'].map(read).join('\n');
  assert.ok(!/api\.openai|api\.anthropic|generativelanguage|oauth|sign[- ]?in|register/i.test(files));
  assert.ok(!existsSync(join(ROOT, 'worker', 'admin.ts')));
  assert.ok(!/Set-Cookie|ADMIN_TOKEN/.test(read('worker/index.ts')), 'admin authentication is not implemented yet');
});

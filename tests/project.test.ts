import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers/sqlite.ts';

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

test('versions: package and schema are 0.4.0; the public learner API contract stays 0.3.0', () => {
  assert.equal(pkg.version, '0.4.0');
  assert.match(read('worker/public-api.ts'), /API_VERSION = '0\.3\.0'/);
  assert.match(read('src/pages/Personal.tsx'), /0\.3\.0/);
  assert.match(read('public/sw.js'), /rdev-academy-v3/);
  assert.match(read('knowledge/acquire.ts'), /RDevAcademyKnowledgeBot\/0\.3/);
  assert.match(read('database/init.sql'), /schema_version','0\.4\.0'/);
  assert.match(read('database/upgrade-0.4.0.sql'), /schema_version'/);
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

test('learner remains accountless while owner administration is isolated', () => {
  const learnerFiles = ['worker/public-api.ts', 'src/App.tsx', 'src/services/initialize.ts', 'src/services/platform.ts'].map(read).join('\n');
  assert.ok(!/api\.openai|api\.anthropic|generativelanguage|oauth|learner[- ]?sign[- ]?in|learner[- ]?register/i.test(learnerFiles));
  assert.ok(existsSync(join(ROOT, 'worker', 'admin-api.ts')));
  assert.match(read('src/App.tsx'), /segments\[0\] === 'owner'/);
  assert.match(read('src/App.tsx'), /lazy\(\(\) => import\('\.\/pages\/Owner\.tsx'\)/, 'owner console must be a lazily loaded chunk');
  assert.ok(!/admin_sessions|login_attempts|security_events|proposals/.test(read('worker/public-api.ts').replace(/^\/\/.*$/gm, '')), 'public API must never query admin or proposal tables');
  assert.ok(!/\/api\/admin/.test(read('public/sw.js')) && /startsWith\('\/api\/'\)/.test(read('public/sw.js')), 'service worker never caches /api');
  assert.ok(read('worker/index.ts').includes("app.all('/api/admin/*'"));
  assert.ok(read('worker/admin-api.ts').includes('OWNER_ADMIN_TOKEN'));
});

test('discovery stays owner-only: no learner route, table access or AI/agent service', () => {
  const learner = ['worker/public-api.ts', 'src/App.tsx', 'src/services/initialize.ts', 'src/services/platform.ts', 'public/sw.js'].map(read).join('\n');
  assert.ok(!/discover|extraction_runs|proposal_provenance|discovery_runs/i.test(learner.replace(/^\s*\/\/.*$/gm, '')), 'learner code and public API never touch discovery');
  assert.ok(!/api\.openai|api\.anthropic|generativelanguage|cohere|llm/i.test(['worker/discovery-api.ts', 'knowledge/discover.ts', 'knowledge/ingest.ts', 'knowledge/retrieve.ts'].map(read).join('\n')), 'no AI research agent');
  assert.ok(!/api\/v1\/.*discover/i.test(read('worker/index.ts')), 'no public discovery endpoint');
  const w = read('wrangler.jsonc'); assert.ok(!/kv_namespaces|durable_objects|r2_buckets|queues|triggers|cron/.test(w), 'no new services or scheduled jobs');
  assert.ok(/\/api\/admin\/\*/.test(read('worker/index.ts')));
});

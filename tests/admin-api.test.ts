import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminApi } from '../worker/admin-api.ts';

const db = { prepare() { throw new Error('DB must not be touched for these unauthenticated checks'); }, batch() { throw new Error('DB must not be touched'); } };

test('owner API refuses access without a session cookie', async () => {
  const response = await adminApi(new Request('https://example.workers.dev/api/admin/overview'), { DB: db, OWNER_ADMIN_TOKEN: 'x'.repeat(40) });
  assert.equal(response?.status, 401);
  assert.match(await response!.text(), /authentication required/i);
});

test('owner login refuses to run until the Worker secret is configured', async () => {
  const response = await adminApi(new Request('https://example.workers.dev/api/admin/login', { method: 'POST', headers: { Origin: 'https://example.workers.dev', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'x'.repeat(40) }) }), { DB: db });
  assert.equal(response?.status, 503);
  assert.match(await response!.text(), /not configured/i);
});

test('owner mutations reject cross-origin requests', async () => {
  const response = await adminApi(new Request('https://example.workers.dev/api/admin/logout', { method: 'POST', headers: { Origin: 'https://attacker.example' } }), { DB: db, OWNER_ADMIN_TOKEN: 'x'.repeat(40) });
  assert.equal(response?.status, 403);
});

test('owner API returns 503 when no D1 binding exists', async () => {
  const response = await adminApi(new Request('https://example.workers.dev/api/admin/overview'), { OWNER_ADMIN_TOKEN: 'x'.repeat(40) });
  assert.equal(response?.status, 503);
});

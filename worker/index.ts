// RDev Academy Worker (Hono). Public, read-only API under /api/v1 plus static assets.
// No accounts, no authentication and no write endpoints exist in this version. Owner-only management
// routes (/api/admin/*) are intentionally NOT implemented yet and answer 404.
import { Hono } from 'hono';
import { API_VERSION, SERVICE, databaseReady, getPublishedPackageBody, listPublishedPackages, listPublishedSources, type Db } from './public-api.ts';
import { isValidVersion } from '../shared/semver.ts';

export type Env = { DB?: Db; ASSETS: { fetch(request: Request): Promise<Response> } };

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const JSON_TYPE = 'application/json; charset=utf-8';

async function etagOf(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return '"' + [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('') + '"';
}

const app = new Hono<{ Bindings: Env }>();

// Headers for every API response.
app.use('/api/*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  await next();
});

app.get('/api/v1/health', async (c) => {
  const db = c.env.DB;
  return c.json({ status: 'ok', service: SERVICE, version: API_VERSION, databaseConfigured: Boolean(db), databaseReady: db ? await databaseReady(db) : false }, 200, { 'Cache-Control': 'no-store' });
});

// Manifest of CURRENT published packages (empty until the owner publishes). Short TTL + ETag.
app.get('/api/v1/packages', async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: 'Knowledge database is not configured.' }, 503, { 'Cache-Control': 'no-store' });
  try {
    const text = JSON.stringify({ packages: await listPublishedPackages(db) });
    const etag = await etagOf(text);
    const headers = { ETag: etag, 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300', 'Content-Type': JSON_TYPE };
    if (c.req.header('If-None-Match') === etag) return c.body(null, 304, headers);
    return c.body(text, 200, headers);
  } catch { return c.json({ error: 'Knowledge database is unavailable or not initialized.' }, 503, { 'Cache-Control': 'no-store' }); }
});

// One package version. Served only while it is the CURRENT version, so a rollback takes effect within the cache TTL.
app.get('/api/v1/packages/:id/:version', async (c) => {
  const db = c.env.DB; const id = c.req.param('id'); const version = c.req.param('version');
  if (!SLUG.test(id) || id.length > 48 || !isValidVersion(version)) return c.json({ error: 'Invalid package id or version.' }, 400, { 'Cache-Control': 'no-store' });
  if (!db) return c.json({ error: 'Knowledge database is not configured.' }, 503, { 'Cache-Control': 'no-store' });
  try {
    const row = await getPublishedPackageBody(db, id, version);
    if (!row) return c.json({ error: 'Package version not found or not current.' }, 404, { 'Cache-Control': 'no-store' });
    const etag = '"' + row.checksum + '"';
    const headers = { ETag: etag, 'Cache-Control': 'public, max-age=300', 'Content-Type': JSON_TYPE };
    if (c.req.header('If-None-Match') === etag) return c.body(null, 304, headers);
    return c.body(row.body, 200, headers);
  } catch { return c.json({ error: 'Knowledge database is unavailable or not initialized.' }, 503, { 'Cache-Control': 'no-store' }); }
});

app.get('/api/v1/sources', async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: 'Knowledge database is not configured.' }, 503, { 'Cache-Control': 'no-store' });
  try { return c.json({ sources: await listPublishedSources(db) }, 200, { 'Cache-Control': 'public, max-age=60' }); }
  catch { return c.json({ error: 'Knowledge database is unavailable or not initialized.' }, 503, { 'Cache-Control': 'no-store' }); }
});

// Everything else under /api: GET/HEAD → 404 (this includes /api/admin/*), other methods → 405.
app.all('/api/*', (c) => (c.req.method === 'GET' || c.req.method === 'HEAD'
  ? c.json({ error: 'Not found' }, 404, { 'Cache-Control': 'no-store' })
  : c.json({ error: 'Method not allowed' }, 405, { 'Cache-Control': 'no-store', Allow: 'GET, HEAD' })));

// Static assets (normally served by Cloudflare before the Worker runs).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;

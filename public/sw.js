// Minimal offline support. Static assets are cached as they are used; /api is never cached.
const CACHE = 'rdev-academy-v3';
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/icons/favicon.svg', '/manifest.webmanifest']).catch(() => undefined))); });
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (event) => {
  const req = event.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/') : Response.error())))
  );
});

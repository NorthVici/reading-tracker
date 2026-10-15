// Hand-rolled service worker (no build plugin, matching this project's
// no-native-deps style — see the hand-rolled PNG icon script noted in
// CLAUDE.md) whose only job is caching the app shell so the installed
// phone icon opens with zero connectivity. It never touches /api/* or the
// local database — that split is handled entirely by client/src/api.js's
// standalone check. Vite content-hashes JS/CSS filenames per build, so
// rather than precaching a hardcoded (and quickly stale) asset list, this
// caches opportunistically as things are actually requested: the first
// online visit after a deploy populates the cache, every visit after that
// — online or off — serves instantly from it with a background refresh.
const CACHE_NAME = 'reading-tracker-shell-v3';
// Everything is resolved against the worker's own scope, so this works both
// when served from / (desktop shortcut) and from a sub-folder (phone site).
const SCOPE = self.registration.scope;

const PRECACHE_URLS = [
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'favicon.svg',
  'sql-wasm-browser.wasm',
].map((p) => new URL(p, SCOPE).href);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // leave Open Library etc. alone
  if (url.pathname.includes('/api/')) return; // never cache API responses

  // Navigations (loading /, /stats, a deep link, a reload) are network-first
  // so you always get the latest shell when online, falling back to the
  // last cached one when not. Every navigation's response is cached under
  // the single scope-URL key — the server sends the same index.html for every
  // non-API route (client-side routing takes over from there), so one entry
  // covers all of them.
  // GitHub Pages sends max-age=600 on every file, including index.html, so a plain
  // fetch(request) can hand back a page up to 10 minutes old — a deployed update
  // looked "not updated" on the phone. cache: 'no-store' always asks the network.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request.url, { cache: 'no-store', credentials: 'same-origin' })
        .then((response) => {
          caches.open(CACHE_NAME).then((cache) => cache.put(SCOPE, response.clone()));
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match(SCOPE)) || new Response('Offline', { status: 503, statusText: 'Offline' });
        })
    );
    return;
  }

  // Static assets (hashed JS/CSS, fonts, icons, the sql.js wasm binary):
  // cache-first for instant offline loads, with a background re-fetch so
  // the cache stays fresh for next time without blocking this load on it.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const networkFetch = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);

      if (cached) return cached;
      return (await networkFetch) || new Response('', { status: 504, statusText: 'Offline and not cached yet' });
    })
  );
});

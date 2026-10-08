// Argus service worker (master plan 6.7): cache the app shell and Cesium's
// static assets for fast repeat starts, never live data. Feeds, websockets,
// health, and brokered tiles always go to the network, so nothing stale or
// sensitive is ever served from cache.
//
//   navigations          network first, cached shell when offline
//   /assets/* (hashed)   cache first (immutable build output)
//   /cesium/*, /icons/*  stale-while-revalidate, entry-capped
//   everything else      not intercepted

// Replaced with a per-build id at build time (vite.config.js), so each build
// starts with fresh caches and the activate step drops the previous build's.
const BUILD = '__ARGUS_BUILD__';
const SHELL = `argus-shell-${BUILD}`;
const STATIC = `argus-static-${BUILD}`;
const STATIC_MAX_ENTRIES = 600;
const LIVE = /^\/(feed|ws|health|tiles)(\/|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(['/', '/manifest.webmanifest']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('argus-') && k !== SHELL && k !== STATIC)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i += 1) await cache.delete(keys[i]);
}

async function networkFirstShell(request) {
  try {
    const res = await fetch(request);
    if (res.ok) (await caches.open(SHELL)).put('/', res.clone());
    return res;
  } catch {
    return (await caches.match('/')) || Response.error();
  }
}

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) {
    const cache = await caches.open(STATIC);
    await cache.put(request, res.clone());
    trim(cache, STATIC_MAX_ENTRIES);
  }
  return res;
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request);
  const refresh = fetch(request)
    .then(async (res) => {
      if (res.ok) {
        await cache.put(request, res.clone());
        trim(cache, STATIC_MAX_ENTRIES);
      }
      return res;
    })
    .catch(() => null);
  if (hit) {
    event.waitUntil(refresh);
    return hit;
  }
  return (await refresh) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // third-party tiles: network only
  if (LIVE.test(url.pathname)) return; // live data: never cached

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
  } else if (url.pathname.startsWith('/cesium/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(staleWhileRevalidate(request, event));
  }
});

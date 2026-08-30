/* Groups service worker.
   Keeps the shell offline-ready and turns Web Push into iPhone notifications. */

const VERSION = '__ASSET_VERSION__';
const SHELL = `groups-shell-${VERSION}`;
const MEDIA = 'groups-media-v1';

// The app may be served from a subpath (GitHub Pages puts it at /<repo>/), so
// everything here is resolved against the worker's own scope, never the origin.
const BASE = new URL('./', self.registration?.scope || self.location.href);
const at = (p) => new URL(p, BASE).toString();

const SHELL_FILES = [
  './',
  'css/theme.css',
  'css/app.css',
  'js/app.js',
  'js/api.js',
  'js/config.js',
  'js/store.js',
  'js/ui.js',
  'js/router.js',
  'js/views/home.js',
  'js/views/hangout.js',
  'js/views/camera.js',
  'js/views/reel.js',
  'js/views/archive.js',
  'js/views/settings.js',
  'js/views/onboarding.js',
  'js/views/connect.js',
  'manifest.webmanifest',
  'icons/mark.svg',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
].map(at);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Never let one 404 sink the whole install.
    await Promise.all(SHELL_FILES.map((file) =>
      cache.add(new Request(file, { cache: 'reload' })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('groups-shell-') && key !== SHELL) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

/* The API may be on another origin entirely, and a notification can be tapped
   with no page open to ask — so the page tells us, and we keep it in a cache. */
const API_BASE_KEY = at('__api-base');

self.addEventListener('message', (event) => {
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
  if (event.data?.type === 'api-base' && event.data.value) {
    event.waitUntil(caches.open(SHELL).then((c) =>
      c.put(API_BASE_KEY, new Response(String(event.data.value)))));
  }
});

async function apiBase() {
  try {
    const hit = await caches.match(API_BASE_KEY);
    if (hit) return (await hit.text()).replace(/\/+$/, '');
  } catch { /* fall through */ }
  return at('.').replace(/\/+$/, '');
}

/* ---------------------------------------------------------------- fetch -- */

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Video and range requests go straight to the network — the browser's own
  // media cache handles them far better than we can.
  if (request.headers.has('range') || url.pathname.includes('/video')) return;

  // Posters are small, immutable and worth keeping for Memory Lane offline.
  if (url.pathname.includes('/poster')) {
    event.respondWith(cacheFirst(request, MEDIA));
    return;
  }

  // The API is always live — and it may well be on another origin entirely.
  if (url.pathname.includes('/api/') || url.origin !== location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        return (await caches.match(at('./'))) || Response.error();
      }
    })());
    return;
  }

  event.respondWith(staleWhileRevalidate(request, SHELL));
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return hit || (await network) || Response.error();
}

/* ----------------------------------------------------------------- push -- */

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { title: 'Groups' }; }

  const title = payload.title || 'Groups';
  const options = {
    body: payload.body || '',
    tag: payload.tag || 'groups',
    renotify: true,
    icon: at('icons/icon-192.png'),
    badge: at('icons/icon-192.png'),
    data: { url: payload.url || './', ...(payload.data || {}) },
    actions: (payload.actions || []).slice(0, 2),
    vibrate: [12, 60, 12],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  let target = data.url || './';

  // Answering a hangout straight from the lock screen.
  if (event.action === 'yes' && data.hangoutId) {
    event.waitUntil(answerHangout(data.hangoutId, 'yes', target));
    return;
  }
  if (event.action === 'no' && data.hangoutId) {
    event.waitUntil(answerHangout(data.hangoutId, 'no', null));
    return;
  }

  event.waitUntil(openApp(target));
});

async function answerHangout(hangoutId, answer, target) {
  try {
    const base = await apiBase();
    await fetch(`${base}/api/hangouts/${hangoutId}/respond`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer }),
    });
  } catch { /* the app will ask again when it opens */ }

  if (answer === 'yes') {
    await self.registration.showNotification("You're in 🎉", {
      body: 'Open Groups to see where they are.',
      icon: at('icons/icon-192.png'),
      tag: `answered-${hangoutId}`,
      data: { url: target || './' },
    });
  }
  if (target) await openApp(target);
}

async function openApp(url) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    if ('focus' in client) {
      client.postMessage({ type: 'navigate', url });
      return client.focus();
    }
  }
  return self.clients.openWindow(url);
}

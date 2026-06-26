/* طلاقة — service worker (offline app shell) */
const CACHE = 'talaqa-v38';
const ASSETS = [
  './',
  './index.html',
  './app-config.js',
  './supabase-bridge.js',
  './vendor/supabase.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => {})
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Navigations -> network first, fall back to the cached shell (SPA + offline).
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }

  // NEVER touch Supabase API / auth / functions / storage / realtime (or any
  // other cross-origin call except Google Fonts) — let them go straight to the
  // network so auth + AI always reach the live backend and nothing is staled.
  const isSupabase = /\/(functions|rest|auth|storage|realtime)\/v1\//.test(url.pathname)
    || url.hostname.endsWith('.supabase.co');
  const isFonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (isSupabase || (url.origin !== location.origin && !isFonts)) {
    return; // default network handling, uncached
  }

  const cacheOk = (res) => res && res.ok && (res.type === 'basic' || res.type === 'cors');

  // App CODE (index.html + the small JS files) — STALE-WHILE-REVALIDATE.
  // Serve the cached copy INSTANTLY (this is the "fast app feel"), then
  // refresh in the background so the NEXT load gets fresh code. The CACHE
  // version bump on every deploy + caches.delete in 'activate' guarantees
  // staleness is bounded to one load after each deploy.
  //
  // We used to be network-first here ("always fresh when online") — but that
  // made EVERY in-app navigation wait on a network round-trip and felt slow
  // on flaky connections. Stale-while-revalidate fixes the perceived lag
  // without sacrificing freshness for the next visit.
  const isContent = url.pathname.includes('/content/');
  const isAppCode = !isContent && /\.(html|js)$/i.test(url.pathname);

  if (isAppCode) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((res) => {
          if (cacheOk(res)) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // Large data under /content/ (curriculum.js / examples.js) -> stale-while-
  // revalidate: serve the cached copy instantly (fast), but refresh in the
  // background so updated content propagates on the NEXT load with no version bump.
  if (isContent) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((res) => {
          if (cacheOk(res)) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // Everything else same-origin (icons) + Google Fonts -> cache first, then
  // network. Only cache successful basic/cors responses.
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (cacheOk(res)) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
        return res;
      }).catch(() => hit);
    })
  );
});

// ---- Web Push: daily reminder that fires even when the app is CLOSED. --------
self.addEventListener('push', (e) => {
  let data = { title: 'طلاقة 🔔', body: 'حان وقت درس اليوم — لا تكسر سلسلتك! 🔥', url: './' };
  try { if (e.data) data = Object.assign(data, e.data.json()); } catch (_) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      lang: 'ar',
      dir: 'rtl',
      tag: 'talaqa-reminder',
      renotify: true,
      data: { url: data.url || './' },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

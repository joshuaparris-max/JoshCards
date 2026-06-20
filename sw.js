// Offline cache. Network-first for the app's own files so deploys land without
// needing to close/reopen; falls back to cache when offline.
const CACHE = 'joshcards-v42';
const ASSETS = ['.', 'index.html', 'styles.css', 'catalog-data.js', 'app.js', 'config.js', 'manifest.webmanifest', 'icons/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Let cross-origin requests (card APIs, card images) go straight to the network.
  if (url.origin !== location.origin) return;
  // Same-origin app files: network-first, cache the fresh copy, fall back offline.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});

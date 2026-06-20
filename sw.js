// Minimal offline cache so the app opens without a connection.
const CACHE = 'joshcards-v40';
const ASSETS = ['.', 'index.html', 'styles.css', 'catalog-data.js', 'app.js', 'config.js', 'manifest.webmanifest', 'icons/icon.svg'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});

/* Cache the app shell so the app opens offline (documents are cached
 * separately in IndexedDB by mobile.js). Bump VERSION on deploy. */
const VERSION = 'as-mobile-v2';
const SHELL = ['./', 'index.html', 'mobile.css', 'mobile.js', 'marked.min.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;   // GitHub/OpenRouter go straight to network
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      if (r.ok) {
        const copy = r.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
      }
      return r;
    }))
  );
});

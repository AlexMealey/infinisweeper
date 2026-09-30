const CACHE_NAME = 'infinisweeper-v17';

const CDN_TO_LOCAL = {
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js': './lib/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js': './lib/react-dom.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.5/babel.min.js': './lib/babel.min.js',
  'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.js': './lib/mp4-muxer.js',
  'https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css': './lib/tailwind.min.css',
};

const PRE_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './sw.js',
  './css/style.css',
  './js/game.js',
  './js/mapimage.js',
  './js/timelapse.js',
  './js/net.js',
  './js/components.js',
  './js/app.js',
  './icons/icon.svg',
  './lib/react.production.min.js',
  './lib/react-dom.production.min.js',
  './lib/babel.min.js',
  './lib/mp4-muxer.js',
  './lib/tailwind.min.css',
];

self.addEventListener('install', event => {
  event.waitUntil(
    // cache: 'reload' skips the HTTP cache, so a new sw.js never pre-caches stale copies next to fresh ones.
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRE_CACHE.map(u => new Request(u, { cache: 'reload' }))))
      .catch(err => { console.error('SW pre-cache failed:', err); throw err; })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Multiplayer endpoints must ALWAYS hit the network — never serve stale sync
  // responses from cache, and don't try to cache them (they're user-specific
  // and change on every request).
  if (url.includes('/php/')) {
    return; // let the browser handle it normally
  }

  const isCDN = url in CDN_TO_LOCAL;

  if (isCDN) {
    // Network-first for CDN resources; fall back to cached CDN response, then local lib
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
              .catch(err => console.error('SW cache write failed:', url, err));
          }
          return response;
        })
        .catch(err => {
          console.error('SW CDN fetch failed, using cache:', url, err);
          return caches.match(event.request).then(cached => {
            if (cached) return cached;
            // Fall back to local lib file
            return caches.match(new Request(CDN_TO_LOCAL[url]));
          });
        })
    );
  } else {
    // Cache-first for local files
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
              .catch(err => console.error('SW cache write failed:', url, err));
          }
          return response;
        });
      })
    );
  }
});

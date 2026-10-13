const CACHE_NAME = 'infinisweeper-v25';

// After this long, a slow network loses to the cached copy. The fetch still finishes and refreshes the cache.
const NETWORK_TIMEOUT_MS = 4000;

const CDN_TO_LOCAL = {
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js': './lib/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js': './lib/react-dom.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.5/babel.min.js': './lib/babel.min.js',
  'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.js': './lib/mp4-muxer.js',
  'https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css': './lib/tailwind.min.css',
};

const PRE_CACHE = [
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/game.js',
  './js/mapimage.js',
  './js/timelapse.js',
  './js/net.js',
  './js/components.js',
  './js/app.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './lib/react.production.min.js',
  './lib/react-dom.production.min.js',
  './lib/babel.min.js',
  './lib/mp4-muxer.js',
  './lib/tailwind.min.css',
];

// Every page of the app is index.html; ?seed= and ?room= are read by the page itself.
const APP_PAGE = new URL('./index.html', self.location).href;
const APP_URLS = [new URL('./', self.location).href, APP_PAGE];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => Promise.all(PRE_CACHE.map(u =>
      // cache: 'reload' skips the HTTP cache, so a new sw.js never pre-caches stale copies next to fresh ones.
      // One missing file is logged, not fatal: a failed install would leave players on the old worker for good.
      cache.add(new Request(u, { cache: 'reload' })).catch(err => console.error('SW pre-cache failed:', u, err))
    )))
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

// Network first, so a deploy shows up on the next load; the cache under cacheKey is the offline copy.
function networkFirst(request, cacheKey, fetchOptions) {
  const fromCache = () => caches.match(cacheKey);
  const fromNetwork = fetch(request, fetchOptions).then(response => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, copy))
        .catch(err => console.error('SW cache write failed:', cacheKey, err));
      return response;
    }
    // Server errors (e.g. the proxy's 502 while the container restarts) lose to the offline copy.
    return response.status >= 500 ? fromCache().then(cached => cached || response) : response;
  });
  const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS))
    .then(fromCache).then(cached => cached || fromNetwork);
  return Promise.race([
    fromNetwork.catch(err => fromCache().then(cached => {
      if (cached) return cached;
      throw err;
    })),
    timeout,
  ]);
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = request.url;

  if (request.method !== 'GET') return;
  // Multiplayer endpoints always go to the network, uncached.
  if (url.includes('/php/')) return;

  if (url in CDN_TO_LOCAL) {
    // Falls back to the local lib/ copy. CDN files are versioned, so the HTTP cache may answer.
    event.respondWith(networkFirst(request, new URL(CDN_TO_LOCAL[url], self.location).href));
    return;
  }
  // Other sites (e.g. the WebAssembly encoder's CDN fallback) are left to the browser.
  if (new URL(url).origin !== self.location.origin) return;

  const path = new URL(url);
  path.search = '';
  path.hash = '';
  const cacheKey = APP_URLS.includes(path.href) ? APP_PAGE : request;
  // no-cache: revalidate with the server (a cheap 304) rather than trust the HTTP cache's guess.
  event.respondWith(networkFirst(request, cacheKey, { cache: 'no-cache' }));
});

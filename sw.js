// Caching strategy:
//  • App files (HTML, JS, CSS, manifest): network first, so a new deploy is
//    picked up on the next load. The cache is only a fallback for offline
//    use or a network slower than NETWORK_TIMEOUT.
//  • Images and the Google Fonts stylesheet: served from cache, refreshed in
//    the background.
//  • Pinned CDN files and font files never change, so they're cache first.
//  • Supabase API calls and non-GET requests are never touched.
//
// Bump CACHE only when PRECACHE changes. Code changes don't need a bump.
const CACHE = 'checklister-v8';
const NETWORK_TIMEOUT = 4000;
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js';
const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700&family=Nunito:wght@400;600;700;800&display=swap';
const PRECACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './logo.png',
  './icon-192.png',
  './icon-512.png',
  SUPABASE_JS,
  FONTS_CSS
];

self.addEventListener('install', e => {
  // Cache each file on its own: one failure (e.g. fonts blocked) shouldn't
  // leave the whole app without an offline copy.
  e.waitUntil(caches.open(CACHE).then(cache => Promise.all(
    PRECACHE.map(url => cache.add(url).catch(err => console.warn('Precache failed:', url, err)))
  )));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('.supabase.co')) return; // live data, never cached

  if (url.origin === location.origin) {
    e.respondWith(/\.(png|jpe?g|svg|ico|webp)$/.test(url.pathname) ? staleWhileRevalidate(e) : networkFirst(e));
  } else if (url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(e));
  } else if (url.hostname === 'fonts.googleapis.com') {
    e.respondWith(staleWhileRevalidate(e));
  }
});

function fetchAndCache(req) {
  return fetch(req).then(res => {
    if (!res.ok && res.type !== 'opaque') return res;
    return caches.open(CACHE)
      .then(cache => cache.put(req, res.clone()))
      .catch(err => console.warn('Cache write failed:', req.url, err))
      .then(() => res);
  });
}

function networkFirst(e) {
  const req = e.request;
  const network = fetchAndCache(req);
  e.waitUntil(network.catch(() => {})); // let the cache update finish even if we answer from cache
  const fromCache = () => caches.match(req, { ignoreSearch: req.mode === 'navigate' })
    .then(res => res || (req.mode === 'navigate' ? caches.match('./index.html') : undefined));

  return new Promise(resolve => {
    let settled = false;
    const finish = res => { if (res && !settled) { settled = true; resolve(res); } };
    // Slow network: answer from cache if we can, otherwise keep waiting.
    const timer = setTimeout(() => fromCache().then(finish), NETWORK_TIMEOUT);
    network.then(
      res => { clearTimeout(timer); finish(res); },
      () => { clearTimeout(timer); fromCache().then(res => finish(res || Response.error())); }
    );
  });
}

function staleWhileRevalidate(e) {
  const network = fetchAndCache(e.request);
  e.waitUntil(network.catch(() => {}));
  return caches.match(e.request).then(cached => cached || network);
}

function cacheFirst(e) {
  return caches.match(e.request).then(cached => cached || fetchAndCache(e.request));
}

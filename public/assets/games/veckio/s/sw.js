// sw.js - No external CDN dependencies

const CACHE_VERSION = 'v2';
const BUILD_CACHE = `build-cache-${CACHE_VERSION}`;
const ASSETS_CACHE = `assets-cache-${CACHE_VERSION}`;
const PAGES_CACHE = `pages-cache-${CACHE_VERSION}`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => ![BUILD_CACHE, ASSETS_CACHE, PAGES_CACHE].includes(k))
        .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

async function handleRequest(event) {
  const { request } = event;
  const url = new URL(request.url);

  // Don't cache cross-origin or non-GET requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return fetch(request);
  }

  // Build files - StaleWhileRevalidate
  if (url.href.includes('/Build/')) {
    const cached = await caches.match(request);
    const fetchPromise = fetch(request).then(res => {
      if (res && res.status === 200) {
        const clone = res.clone();
        caches.open(BUILD_CACHE).then(c => c.put(request, clone));
      }
      return res;
    }).catch(() => cached);
    return cached || fetchPromise;
  }

  // Assets (images, CSS, JS) - StaleWhileRevalidate
  if (['style', 'script', 'image'].includes(request.destination)) {
    const cached = await caches.match(request);
    const fetchPromise = fetch(request).then(res => {
      if (res && res.status === 200) {
        const clone = res.clone();
        caches.open(ASSETS_CACHE).then(c => c.put(request, clone));
      }
      return res;
    }).catch(() => cached);
    return cached || fetchPromise;
  }

  // HTML navigation - NetworkFirst
  if (request.mode === 'navigate') {
    try {
      const res = await fetch(request);
      if (res && res.status === 200) {
        const clone = res.clone();
        caches.open(PAGES_CACHE).then(c => c.put(request, clone));
      }
      return res;
    } catch {
      return caches.match(request);
    }
  }

  return fetch(request);
}

self.addEventListener('fetch', event => {
  event.respondWith(handleRequest(event));
});
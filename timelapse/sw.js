const CACHE_NAME = 'timelapse-v2';
const RUNTIME_CACHE = 'timelapse-runtime-v2';

const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './align.js',
  './zip.js',
  './photos.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// MediaPipe's wasm bundle and model come from these hosts; cache them at
// runtime so face detection keeps working offline after one online run.
const RUNTIME_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (RUNTIME_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const hit = await cache.match(event.request);
        if (hit) return hit;
        const res = await fetch(event.request);
        if (res.ok) cache.put(event.request, res.clone());
        return res;
      })
    );
    return;
  }

  // Google's auth and Picker endpoints must never be served from a cache.
  if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('google.com')) return;

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});

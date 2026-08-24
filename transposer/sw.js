const CACHE_NAME = 'transposer-v1';
const RUNTIME_CACHE = 'transposer-runtime-v1';

const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './transpose.js',
  './chords.js',
  './mxl.js',
  './player.js',
  './manifest.json',
  './demo/amazing-grace.musicxml',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Third-party origins cached at runtime (OSMD, pdf.js), so the app keeps
// working with no network once it has run online once.
const RUNTIME_HOSTS = ['cdn.jsdelivr.net'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
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
  if (event.request.method !== 'GET') return;

  if (RUNTIME_HOSTS.includes(url.hostname)) {
    // Cache-first for large, versioned third-party assets.
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((resp) => {
            if (resp.ok || resp.type === 'opaque') {
              const copy = resp.clone();
              caches.open(RUNTIME_CACHE).then((cache) => cache.put(event.request, copy));
            }
            return resp;
          })
      )
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

const CACHE = 'coachlog-v2';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-512.png', './icon-180.png'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE);
            await cache.addAll(ASSETS);
            await self.skipWaiting();
        })(),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();
            await Promise.all(keys.filter((key) => key !== CACHE).map(async (key) => caches.delete(key)));
            await self.clients.claim();
        })(),
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    event.respondWith(
        (async () => {
            const hit = await caches.match(event.request, { ignoreSearch: true });
            return hit || fetch(event.request);
        })(),
    );
});

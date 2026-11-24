// Macrolens service worker: precached app shell (offline-first), cache-first CDN/runtime assets
// (Transformers.js, ONNX Runtime WASM, ZXing, fonts) and a bounded product-image cache.
// AI model weights are cached by Transformers.js itself in the 'transformers-cache' bucket.

const VERSION = 'v1.2.0';
const SHELL_CACHE = `macrolens-shell-${VERSION}`;
const RUNTIME_CACHE = 'macrolens-runtime-v1';
const IMAGE_CACHE = 'macrolens-images-v1';
const IMAGE_LIMIT = 300;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './css/coach.css',
  './js/app.js',
  './js/cloud.js',
  './js/vision.js',
  './js/agent/agent.js',
  './js/agent/tools.js',
  './js/views/coach.js',
  './js/sheets/snap-cloud.js',
  './js/sheets/aisetup.js',
  './js/util.js',
  './js/db.js',
  './js/store.js',
  './js/nutrition.js',
  './js/fooddb.js',
  './js/grade.js',
  './js/grade-data.js',
  './js/icons.js',
  './js/ui.js',
  './js/celebrate.js',
  './js/api.js',
  './js/scanner.js',
  './js/ai.js',
  './js/ai-worker.js',
  './js/install.js',
  './js/views/dashboard.js',
  './js/views/diary.js',
  './js/views/week.js',
  './js/views/profile.js',
  './js/sheets/addfood.js',
  './js/sheets/food.js',
  './js/sheets/calculator.js',
  './js/sheets/onboarding.js',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/shortcut-scan.png',
  './icons/shortcut-snap.png',
  './icons/shortcut-diary.png',
  './models/mcs0-text-v1.json',
  './models/mcs0-text-v1.bin',
];

const RUNTIME_HOSTS = new Set(['cdn.jsdelivr.net', 'fastly.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com']);
const IMAGE_HOSTS = new Set(['images.openfoodfacts.org', 'static.openfoodfacts.org']);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('macrolens-shell-') && k !== SHELL_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

const cacheable = res => res && (res.ok || res.type === 'opaque');

async function cacheFirst(request, cacheName, limit) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (cacheable(res)) {
    cache.put(request, res.clone()).then(async () => {
      if (!limit) return;
      const keys = await cache.keys();
      for (let i = 0; i < keys.length - limit; i++) await cache.delete(keys[i]);
    }).catch(() => {});
  }
  return res;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (request.mode === 'navigate') {
      event.respondWith(
        caches.match('./index.html').then(hit => hit || fetch(request)).catch(() => caches.match('./index.html')),
      );
      return;
    }
    event.respondWith(caches.match(request, { ignoreSearch: true }).then(hit => hit || fetch(request)));
    return;
  }

  if (RUNTIME_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }
  if (IMAGE_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(request, IMAGE_CACHE, IMAGE_LIMIT).catch(() => new Response('', { status: 504 })));
  }
  // Food APIs and Hugging Face model downloads go straight to the network.
});

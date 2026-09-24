// StreamCast service worker: makes the app installable and loads the shell
// instantly. Always tries the network first so updates are picked up.
const CACHE = 'streamcast-v2';
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/main.js',
  '/js/config.js',
  '/js/util.js',
  '/js/device.js',
  '/js/api.js',
  '/js/rtc.js',
  '/js/audio.js',
  '/js/ui.js',
  '/js/host.js',
  '/js/viewer.js',
  '/js/hdr.js',
  '/js/vendor/qrcode.mjs',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(request.mode === 'navigate' ? '/index.html' : request, copy));
        }
        return response;
      })
      .catch(async () => (await caches.match(request)) || (request.mode === 'navigate' ? caches.match('/index.html') : Response.error())),
  );
});

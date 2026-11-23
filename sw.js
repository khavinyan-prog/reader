// Offline cache: app shell and vendored libraries, cache-first.
const VERSION = 'reader-v3';
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/book.js',
  'js/text.js',
  'js/tts.js',
  'js/store.js',
  'js/ocr.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs',
  'vendor/fonts/literata-latin-opsz-normal.woff2',
  'vendor/fonts/frank-ruhl-libre-hebrew-wght-normal.woff2',
  'vendor/fonts/frank-ruhl-libre-latin-wght-normal.woff2',
  'vendor/fonts/rubik-hebrew-wght-normal.woff2',
  'vendor/fonts/rubik-latin-wght-normal.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('index.html').then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        // Extra pdf.js data (cmaps, fonts, decoders) and OCR files are cached the first time they are used.
        if (res.ok && url.pathname.includes('/vendor/')) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      });
    }),
  );
});

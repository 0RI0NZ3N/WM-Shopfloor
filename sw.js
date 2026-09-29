/* Offline cache. Bump VERSION on every deploy so tablets pick up the new build. */
const VERSION = 'meii-shopfloor-v6';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'db.js', 'parse.js', 'ocr.js', 'pdfexport.js', 'zebra.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/logo-light.png', 'icons/logo-dark.png', 'icons/favicon.png', 'icons/apple-touch-icon.png', 'vendor/qrcode.js', 'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs', 'vendor/pdf-lib.min.js',
  'vendor/tesseract-lib.js', 'vendor/tesseract-core.wasm', 'vendor/tesseract-core-fallback.wasm', 'vendor/eng.traineddata'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if(url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(res => {
    if(res.ok){ const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => e.request.mode === 'navigate' ? caches.match('index.html') : undefined)));
});

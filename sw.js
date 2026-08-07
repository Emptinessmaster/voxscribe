/* =========================================================================
   VoxScribe — Service Worker
   Rende l'app installabile e funzionante OFFLINE.

   Strategia:
   - App shell same-origin (HTML/CSS/JS/worker/manifest/icone) e navigazioni:
     NETWORK-FIRST (online sempre aggiornato, offline dalla cache).
   - Librerie da CDN (Transformers.js, ONNX runtime, FFmpeg): CACHE-FIRST,
     così restano disponibili offline.
   - Pesi dei modelli (huggingface): NON gestiti qui — Transformers.js usa la
     propria cache ('transformers-cache'), quindi li lasciamo passare in rete
     per non duplicare centinaia di MB.
   ========================================================================= */
var CACHE = 'voxscribe-v1';

var APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './whisper.worker.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg'
];

// Host dei pesi dei modelli: lasciati alla cache interna di Transformers.js.
function isModelHost(url) {
  return /huggingface\.co$/.test(url.hostname) ||
         /\.hf\.co$/.test(url.hostname) ||
         /cdn-lfs/.test(url.hostname);
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(APP_SHELL.map(function (url) {
        return fetch(url, { cache: 'reload' }).then(function (res) {
          if (res && (res.ok || res.type === 'opaque')) return cache.put(url, res);
        }).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (event) {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function putInCache(req, res) {
  var copy = res.clone();
  caches.open(CACHE).then(function (cache) { cache.put(req, copy); }).catch(function () {});
  return res;
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Pesi dei modelli: passa in rete, gestiti dalla cache di Transformers.js.
  if (isModelHost(url)) return;

  var sameOrigin = url.origin === self.location.origin;
  var isNav = req.mode === 'navigate';

  if (sameOrigin || isNav) {
    // NETWORK-FIRST
    event.respondWith(
      fetch(req).then(function (res) { return putInCache(req, res); }).catch(function () {
        return caches.match(req).then(function (cached) {
          return cached || (isNav ? caches.match('./index.html') : Response.error());
        });
      })
    );
    return;
  }

  // CDN (Transformers.js, ORT wasm, FFmpeg): CACHE-FIRST.
  event.respondWith(
    caches.match(req).then(function (cached) {
      return cached || fetch(req).then(function (res) { return putInCache(req, res); });
    })
  );
});

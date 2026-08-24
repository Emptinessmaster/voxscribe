/* =========================================================================
   VoxScribe — Service Worker
   Rende l'app installabile e funzionante OFFLINE.

   Strategia:
   - App shell same-origin (HTML/CSS/JS/worker/manifest/icone) e navigazioni:
     NETWORK-FIRST (online sempre aggiornato, offline dalla cache).
   - Librerie da jsDelivr (Transformers.js, ONNX runtime, FFmpeg): CACHE-FIRST,
     così restano disponibili offline.
   - Tutto il resto cross-origin (in particolare i PESI DEI MODELLI da
     Hugging Face) passa DIRETTAMENTE in rete: il SW non li tocca mai, così non
     interferisce col download né con la cache interna di Transformers.js.
   ========================================================================= */
var CACHE = 'voxscribe-v5';

// Solo questi host cross-origin vengono messi in cache dal SW (le nostre dipendenze).
function isTrustedCdn(hostname) { return hostname === 'cdn.jsdelivr.net'; }

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

  var sameOrigin = url.origin === self.location.origin;
  var isNav = req.mode === 'navigate';

  if (sameOrigin || isNav) {
    // NETWORK-FIRST per l'app shell (online sempre aggiornato, offline da cache).
    event.respondWith(
      fetch(req).then(function (res) { return putInCache(req, res); }).catch(function () {
        return caches.match(req).then(function (cached) {
          return cached || (isNav ? caches.match('./index.html') : Response.error());
        });
      })
    );
    return;
  }

  // Solo le nostre dipendenze da jsDelivr vengono cache-ate (per l'offline).
  if (isTrustedCdn(url.hostname)) {
    event.respondWith(
      caches.match(req).then(function (cached) {
        return cached || fetch(req).then(function (res) { return putInCache(req, res); });
      })
    );
    return;
  }

  // Tutto il resto (pesi dei modelli da Hugging Face, ecc.): passa in rete,
  // il SW non interviene affatto.
});

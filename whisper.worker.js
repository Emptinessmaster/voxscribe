/* =========================================================================
   VoxScribe — Web Worker per la trascrizione (Whisper via Transformers.js)
   Gira fuori dal thread principale per non bloccare la UI. Il modello viene
   scaricato una sola volta e messo in cache dal browser per l'uso offline.
   L'audio (Float32 mono 16 kHz) viene trascritto a finestre sequenziali così
   i segmenti compaiono progressivamente, con timestamp.
   ========================================================================= */
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

// Nessun modello locale: si scarica dall'hub e si mette in cache nel browser.
env.allowLocalModels = false;
env.useBrowserCache = true; // cache dei pesi per l'uso offline (predefinito, reso esplicito)

// Su hosting statico (GitHub Pages) la pagina non è cross-origin isolated:
// niente SharedArrayBuffer → ONNX Runtime deve girare a thread singolo.
try {
  if (!self.crossOriginIsolated) {
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
  }
} catch (e) {}

var transcriber = null;
var loadedModel = null;

async function getPipeline(model) {
  if (transcriber && loadedModel === model) return transcriber;
  transcriber = await pipeline('automatic-speech-recognition', model, {
    progress_callback: function (p) { self.postMessage({ type: 'progress', data: p }); }
  });
  loadedModel = model;
  return transcriber;
}

self.onmessage = async function (e) {
  var msg = e.data || {};
  if (msg.type !== 'transcribe') return;

  var audio = msg.audio;             // Float32Array mono
  var sampleRate = msg.sampleRate;   // 16000
  var model = msg.model || 'Xenova/whisper-tiny';
  var language = msg.language;       // 'auto' o nome lingua
  var chunkSec = msg.chunkSec || 20; // < 30 s: elaborato nativamente da Whisper

  try {
    var pipe = await getPipeline(model);
    self.postMessage({ type: 'ready' });

    var total = audio.length;
    var per = Math.floor(chunkSec * sampleRate);
    if (per <= 0) per = total;

    for (var start = 0; start < total; start += per) {
      var end = Math.min(start + per, total);
      var slice = audio.subarray(start, end);
      var offset = start / sampleRate;

      var opts = { return_timestamps: true };
      if (language && language !== 'auto') { opts.language = language; opts.task = 'transcribe'; }

      var out = await pipe(slice, opts);

      var raw = (out && out.chunks && out.chunks.length)
        ? out.chunks
        : [{ timestamp: [0, slice.length / sampleRate], text: (out && out.text) || '' }];

      var segments = raw.map(function (c) {
        var s = (c.timestamp && c.timestamp[0] != null) ? c.timestamp[0] : 0;
        var en = (c.timestamp && c.timestamp[1] != null) ? c.timestamp[1] : (slice.length / sampleRate);
        return { start: s + offset, end: en + offset, text: (c.text || '').trim() };
      }).filter(function (s) { return s.text; });

      self.postMessage({ type: 'segments', segments: segments, progress: end / total });
    }

    self.postMessage({ type: 'done' });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};

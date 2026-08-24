/* =========================================================================
   VoxScribe — Web Worker per la trascrizione (Whisper via Transformers.js)
   Gira fuori dal thread principale per non bloccare la UI. Il modello viene
   scaricato una sola volta e messo in cache dal browser per l'uso offline.

   L'audio (Float32 mono 16 kHz) viene passato INTERO all'algoritmo long-form
   nativo di Whisper (chunk_length_s + stride_length_s): finestre da 30 s con
   sovrapposizione, unite tra loro allineando i timestamp. È molto più preciso
   del taglio manuale a finestre fisse (che spezzava le parole a ogni bordo e
   perdeva il contesto tra una finestra e l'altra), soprattutto sul canto.
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

  // Solo scaricamento + messa in cache del modello (senza trascrivere), usato dal
  // pannello "Modelli" per pre-scaricare un modello e renderlo residente/offline.
  if (msg.type === 'preload') {
    try {
      await getPipeline(msg.model || 'Xenova/whisper-base');
      self.postMessage({ type: 'ready' });
      self.postMessage({ type: 'done' });
    } catch (err) {
      self.postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
    return;
  }

  if (msg.type !== 'transcribe') return;

  var audio = msg.audio;                 // Float32Array mono
  var sampleRate = msg.sampleRate || 16000;
  var model = msg.model || 'Xenova/whisper-base';
  var language = msg.language;           // 'auto' o nome lingua

  // Finestra da 30 s (massimo nativo di Whisper) con 5 s di sovrapposizione per lato.
  var CHUNK_S = 30, STRIDE_S = 5;

  try {
    var pipe = await getPipeline(model);
    self.postMessage({ type: 'ready' });

    var durationSec = audio.length / sampleRate;

    // Stima del numero di finestre, solo per far avanzare la barra di avanzamento.
    var stepSec = Math.max(1, CHUNK_S - 2 * STRIDE_S);
    var estChunks = Math.max(1, Math.ceil(Math.max(0, durationSec - CHUNK_S) / stepSec) + 1);
    var doneChunks = 0;

    var opts = {
      chunk_length_s: CHUNK_S,
      stride_length_s: STRIDE_S,
      return_timestamps: true,

      // --- Decodifica di qualità (indipendente dalla dimensione del modello) ---
      // Beam search: esplora più ipotesi e sceglie la più probabile, invece di
      // prendere sempre la parola più probabile a ogni passo (greedy). Migliora
      // la resa sul canto, al costo di più tempo di calcolo.
      num_beams: 3,
      // Evita che il modello ripeta la stessa sequenza di 3+ parole: taglia i
      // loop di "allucinazioni" tipici sulle parti strumentali/musicali.
      no_repeat_ngram_size: 3,

      // Chiamata al termine di ogni finestra: la usiamo solo per l'avanzamento.
      chunk_callback: function () {
        doneChunks++;
        self.postMessage({ type: 'chunk', progress: Math.min(0.99, doneChunks / estChunks) });
      }
    };
    // Fissare la lingua evita che il rilevamento automatico sbagli sull'intro
    // strumentale di un brano musicale.
    if (language && language !== 'auto') { opts.language = language; opts.task = 'transcribe'; }

    var out = await pipe(audio, opts);

    var raw = (out && out.chunks && out.chunks.length)
      ? out.chunks
      : [{ timestamp: [0, durationSec], text: (out && out.text) || '' }];

    var segments = raw.map(function (c) {
      var s = (c.timestamp && c.timestamp[0] != null) ? c.timestamp[0] : 0;
      var en = (c.timestamp && c.timestamp[1] != null) ? c.timestamp[1] : durationSec;
      return { start: s, end: en, text: (c.text || '').trim() };
    }).filter(function (s) { return s.text; });

    self.postMessage({ type: 'segments', segments: segments, progress: 1 });
    self.postMessage({ type: 'done' });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};

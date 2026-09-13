import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
import './transcription.js?v=lectures-1';
import './model-cache.js?v=lectures-1';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.useCustomCache = true;
env.customCache = createVoxModelCache(caches, self.location.href);
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
env.backends.onnx.wasm.proxy = false;
let transcriber = null, loadedKey = '', busy = false, selectedDevice = '';

async function getPipeline(model, device, send) {
  if (!VoxASR.MODELS.some(m => m.id === model)) throw new Error('Modello non consentito.');
  let adapter = null;
  if (device !== 'wasm' && navigator.gpu) {
    try { adapter = await navigator.gpu.requestAdapter(); } catch (_) {}
  }
  const gpu = !!adapter, turbo = model.endsWith('large-v3-turbo');
  if (turbo && !gpu) throw new Error('Turbo richiede WebGPU. Scegli Small o Base su questo dispositivo.');
  const target = gpu ? 'webgpu' : 'wasm', key = model + ':' + target;
  if (transcriber && loadedKey === key) return transcriber;
  if (transcriber) { await transcriber.dispose(); transcriber = null; loadedKey = ''; }
  const opts = {
    device: target,
    dtype: target === 'webgpu' ? { encoder_model: turbo && adapter.features.has('shader-f16') ? 'fp16' : 'fp32', decoder_model_merged: 'q4' } : 'q8',
    progress_callback: data => send('progress', { data })
  };
  try { transcriber = await pipeline('automatic-speech-recognition', model, opts); }
  catch (e) {
    if (!navigator.onLine) throw new Error('Modello o runtime non presente in cache per questa modalità. Ricollegati per prepararlo, oppure usa un modello già verificato offline.');
    throw new Error((gpu ? 'Errore GPU o memoria insufficiente. Prova CPU e Small/Base. ' : '') + e.message);
  }
  loadedKey = key; selectedDevice = target;
  return transcriber;
}

self.onmessage = async e => {
  const m = e.data || {};
  const send = (type, data = {}) => self.postMessage({ id: m.id, type, ...data });
  if (busy) { send('error', { message: 'Motore occupato.' }); return; }
  busy = true;
  try {
    const pipe = await getPipeline(m.model, m.device, send);
    send('ready', { device: selectedDevice });
    if (m.type === 'preload') { send('result', { device: selectedDevice }); return; }
    if (m.type !== 'transcribe' || !(m.audio instanceof Float32Array) || m.audio.length > 70 * VoxASR.RATE) {
      throw new Error('Blocco audio non valido.');
    }
    const options = {
      chunk_length_s: 30, stride_length_s: 5, return_timestamps: true,
      task: 'transcribe', num_beams: 1, do_sample: false,
      chunk_callback: () => send('chunk')
    };
    if (m.language && m.language !== 'auto') options.language = m.language;
    const out = await pipe(m.audio, options);
    const chunks = out.chunks?.length ? out.chunks : [{ timestamp: [0, m.audio.length / VoxASR.RATE], text: out.text || '' }];
    send('result', { chunks, device: selectedDevice });
  } catch (e) { send('error', { message: String(e.message || e) }); }
  finally { busy = false; }
};

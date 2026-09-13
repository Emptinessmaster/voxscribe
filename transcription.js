/* Local-only ASR orchestration. No audio or transcript network requests. */
(function (root) {
  'use strict';
  const RATE = 16000, VERSION = 'lectures-1', CHECKPOINT = 'voxscribe-transcript-lectures-1';
  const MODELS = [
    { id: 'onnx-community/whisper-small', name: 'Small', desc: 'Consigliato per lezioni IT/EN. GPU quando disponibile; CPU come riserva.' },
    { id: 'onnx-community/whisper-base', name: 'Base', desc: 'Più leggero per PC senza GPU compatibile; accuratezza da verificare.' },
    { id: 'onnx-community/whisper-large-v3-turbo', name: 'Large v3 Turbo', desc: 'Qualità avanzata. Richiede GPU e molta memoria. Download iniziale voluminoso: prepara il modello prima di lavorare offline.' }
  ];
  async function fingerprint(blob) {
    const hashes = [];
    for (let offset = 0; offset < blob.size; offset += 4 * 1024 * 1024) {
      const chunk = await blob.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer();
      const digest = await root.crypto.subtle.digest('SHA-256', chunk);
      hashes.push(Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join(''));
    }
    const digest = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(blob.size + ':' + hashes.join(':')));
    return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
  }
  function windowAt(start, duration) {
    const end = Math.min(duration, start + 60);
    return { start, end, from: Math.max(0, start - 5), to: Math.min(duration, end + 5) };
  }
  // Conservative silence detection: do not discard quiet speech.
  function isSilent(audio) {
    let energy = 0, peak = 0;
    for (let i = 0; i < audio.length; i++) { peak = Math.max(peak, Math.abs(audio[i])); energy += audio[i] * audio[i]; }
    return peak < 0.0001 && energy / Math.max(1, audio.length) < 1e-10;
  }
  function segmentsForWindow(chunks, w) {
    return chunks.map(c => {
      const t = c.timestamp || [];
      return { start: Number.isFinite(t[0]) ? t[0] + w.from : w.start,
        end: Number.isFinite(t[1]) ? t[1] + w.from : w.to, text: String(c.text || '').trim() };
    }).filter(s => s.text && s.end > w.start && s.start < w.end && s.end > s.start)
      .map(s => ({ ...s, overlap: s.start < w.start, start: Math.max(w.start, s.start), end: Math.min(w.end, s.end) }));
  }
  function appendSegments(existing, incoming) {
    const added = [];
    for (const item of incoming) {
      const s = { ...item }, previous = added[added.length - 1] || existing[existing.length - 1];
      if (previous) {
        if (s.end <= previous.end) continue;
        if (s.overlap && s.start <= previous.end + 0.15) {
          const a = previous.text.split(/\s+/), b = s.text.split(/\s+/);
          const norm = w => w.toLocaleLowerCase().replace(/[.,!?;:]+$/g, '');
          for (let n = Math.min(a.length, b.length, 40); n >= 3; n--) {
            if (a.slice(-n).map(norm).join(' ') === b.slice(0, n).map(norm).join(' ')) { s.text = b.slice(n).join(' '); break; }
          }
        }
        s.start = Math.max(s.start, previous.end);
      }
      delete s.overlap;
      if (s.text && s.end > s.start) added.push(s);
    }
    return added;
  }
  function readCheckpoint(storage) {
    try {
      const c = JSON.parse(storage.getItem(CHECKPOINT));
      if (!c || c.version !== VERSION || typeof c.key !== 'string' || !c.key ||
          !Number.isFinite(c.duration) || c.duration <= 0 || !Number.isFinite(c.next) || c.next < 0 || c.next > c.duration ||
          !MODELS.some(m => m.id === c.model) || !['italian', 'english', 'auto'].includes(c.language) ||
          (c.gain != null && (!Number.isFinite(c.gain) || c.gain < 0 || c.gain > 3)) ||
          !Array.isArray(c.segments) || !c.segments.every(s => typeof s.text === 'string' && Number.isFinite(s.start) &&
            Number.isFinite(s.end) && s.start >= 0 && s.end > s.start && s.end <= c.next + 0.01)) return null;
      return c;
    } catch (_) { return null; }
  }
  class Engine {
    constructor(factory) { this.factory = factory; this.worker = null; this.pending = null; this.sequence = 0; }
    request(message, onProgress = () => {}) {
      if (this.pending) return Promise.reject(new Error('Motore già occupato.'));
      if (!this.worker) {
        this.worker = this.factory();
        this.worker.onmessage = e => {
          const p = this.pending, m = e.data;
          if (!p || m.id !== p.id) return;
          if (m.type === 'result') { this.pending = null; p.resolve(m); }
          else if (m.type === 'error') { this.pending = null; p.reject(new Error(m.message)); }
          else p.onProgress(m);
        };
        this.worker.onerror = e => this.cancel(e.message || 'Errore del motore locale.');
        this.worker.onmessageerror = () => this.cancel('Risposta del motore non leggibile.');
      }
      return new Promise((resolve, reject) => {
        const id = ++this.sequence; this.pending = { id, resolve, reject, onProgress };
        try { this.worker.postMessage({ ...message, id }, message.audio ? [message.audio.buffer] : []); }
        catch (e) { this.pending = null; reject(e); }
      });
    }
    cancel(reason = 'Interrotto') {
      if (this.worker) this.worker.terminate();
      this.worker = null;
      const p = this.pending; this.pending = null;
      if (p) p.reject(new Error(reason));
    }
  }
  const api = { RATE, VERSION, CHECKPOINT, MODELS, fingerprint, windowAt, isSilent, segmentsForWindow, appendSegments, readCheckpoint, Engine };
  root.VoxASR = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);

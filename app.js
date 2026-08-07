/* =========================================================================
   VoxScribe — logica applicativa (Vanilla JS)
   Editing audio con Web Audio API, trascrizione con Whisper (Transformers.js)
   in un Web Worker. Export WAV nativo + MP3 via FFmpeg.wasm (on-demand).
   Tutto 100% client-side: audio e testo non lasciano mai il dispositivo.
   ========================================================================= */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* ------------------------------------------------------------------ *
   *  Utility
   * ------------------------------------------------------------------ */
  function fmtTime(sec) {
    sec = Math.max(0, sec || 0);
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fmtSrtTime(sec) {
    sec = Math.max(0, sec || 0);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = Math.floor(sec % 60);
    var ms = Math.floor((sec - Math.floor(sec)) * 1000);
    var pad = function (n, l) { n = '' + n; while (n.length < l) n = '0' + n; return n; };
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + ',' + pad(ms, 3);
  }

  var toastEl = $('toast'), toastTimer;
  function toast(msg, type) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (type ? ' ' + type : '');
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 3400);
  }

  function setBusy(btn, busy) {
    if (!btn) return;
    var sp = btn.querySelector('.btn-spinner');
    if (sp) sp.hidden = !busy;
    btn.classList.toggle('is-busy', busy);
    btn.disabled = busy;
  }

  function downloadBlob(blob, filename, triggerDonate) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    if (triggerDonate !== false) setTimeout(showDonateModal, 500);
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = function () { reject(new Error('load ' + src)); };
      document.head.appendChild(s);
    });
  }

  /* ------------------------------------------------------------------ *
   *  Modali / interazioni globali
   * ------------------------------------------------------------------ */
  function openModal(el) { if (el) el.hidden = false; }
  function closeModal(el) { if (el) el.hidden = true; }
  function showDonateModal() { openModal($('donateModal')); }

  document.addEventListener('click', function (e) {
    if (e.target.matches('[data-close-modal]')) closeModal(e.target.closest('.modal-backdrop'));
    if (e.target.classList.contains('modal-backdrop')) closeModal(e.target);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeModal($('howModal')); closeModal($('donateModal')); }
  });
  var howBtn = $('howBtn'); if (howBtn) howBtn.addEventListener('click', function () { openModal($('howModal')); });

  var themeToggle = $('themeToggle');
  if (themeToggle) themeToggle.addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme') || 'dark';
    var next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('voxscribe-theme', next); } catch (e) {}
  });

  var yearEl = $('year'); if (yearEl) yearEl.textContent = new Date().getFullYear();

  // Indicatore online/offline
  function updateNetStatus() {
    var pill = $('localStatus'), txt = $('localStatusText');
    if (!pill || !txt) return;
    if (navigator.onLine) {
      pill.classList.remove('offline');
      txt.textContent = '🟢 100% Elaborazione Locale (funziona anche in Modalità Aereo)';
    } else {
      pill.classList.add('offline');
      txt.textContent = '✈️ Offline — l\'app funziona lo stesso, tutto in locale';
    }
  }
  window.addEventListener('online', updateNetStatus);
  window.addEventListener('offline', updateNetStatus);
  updateNetStatus();

  /* ================================================================== *
   *  MOTORE AUDIO
   * ================================================================== */
  var audioCtx = null;
  function ctx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  var state = {
    buffer: null,        // AudioBuffer corrente
    filename: 'audio',
    selection: null,     // {start,end} in secondi
    gain: 1,             // guadagno master (0..3)
    history: [],         // stack AudioBuffer per undo
    playing: false
  };

  // Riferimenti UI
  var sourcePanel = $('sourcePanel'), editorPanel = $('editorPanel'),
      transcribePanel = $('transcribePanel'), exportPanel = $('exportPanel');
  var canvas = $('waveform'), selEl = $('waveSelection'), playheadEl = $('wavePlayhead');
  var waveWrap = canvas ? canvas.parentElement : null;

  function makeBuffer(numCh, len, sr) { return ctx().createBuffer(numCh, Math.max(1, len), sr); }

  function sliceBuffer(buf, startSec, endSec) {
    var sr = buf.sampleRate;
    var s = Math.max(0, Math.floor(startSec * sr));
    var e = Math.min(buf.length, Math.floor(endSec * sr));
    var len = Math.max(0, e - s);
    var out = makeBuffer(buf.numberOfChannels, len, sr);
    for (var ch = 0; ch < buf.numberOfChannels; ch++) out.getChannelData(ch).set(buf.getChannelData(ch).subarray(s, e));
    return out;
  }
  function removeRegion(buf, startSec, endSec) {
    var sr = buf.sampleRate;
    var s = Math.max(0, Math.floor(startSec * sr));
    var e = Math.min(buf.length, Math.floor(endSec * sr));
    var len = buf.length - (e - s);
    var out = makeBuffer(buf.numberOfChannels, len, sr);
    for (var ch = 0; ch < buf.numberOfChannels; ch++) {
      var d = out.getChannelData(ch), src = buf.getChannelData(ch);
      d.set(src.subarray(0, s), 0);
      d.set(src.subarray(e), s);
    }
    return out;
  }

  function pushHistory() {
    state.history.push(state.buffer);
    if (state.history.length > 20) state.history.shift();
    $('undoBtn').disabled = state.history.length === 0;
  }

  // ---- Rendering forma d'onda ----
  function drawWaveform() {
    if (!state.buffer || !canvas) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cssW = waveWrap.clientWidth || 800;
    var cssH = 180;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.height = cssH + 'px';
    var g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);

    var data = state.buffer.getChannelData(0);
    var mid = cssH / 2;
    var samplesPerPx = Math.max(1, Math.floor(data.length / cssW));
    var styles = getComputedStyle(document.documentElement);
    var accent = styles.getPropertyValue('--accent').trim() || '#8B5CF6';
    var faint = styles.getPropertyValue('--hairline-strong').trim() || 'rgba(255,255,255,.16)';

    // linea centrale
    g.strokeStyle = faint; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, mid); g.lineTo(cssW, mid); g.stroke();

    g.fillStyle = accent;
    for (var x = 0; x < cssW; x++) {
      var startI = x * samplesPerPx, min = 1, max = -1;
      for (var i = 0; i < samplesPerPx; i++) {
        var v = data[startI + i] || 0;
        if (v < min) min = v; if (v > max) max = v;
      }
      var yTop = mid + min * mid * 0.92 * state.gain;
      var h = Math.max(1, (max - min) * mid * 0.92 * state.gain);
      g.fillRect(x, Math.max(0, yTop), 1, Math.min(cssH, h));
    }
    updateSelectionOverlay();
  }

  function updateSelectionOverlay() {
    if (!state.buffer) return;
    var dur = state.buffer.duration;
    if (state.selection && state.selection.end > state.selection.start) {
      var l = (state.selection.start / dur) * 100;
      var w = ((state.selection.end - state.selection.start) / dur) * 100;
      selEl.style.left = l + '%'; selEl.style.width = w + '%'; selEl.hidden = false;
    } else {
      selEl.hidden = true;
    }
  }

  function refreshEditorInfo() {
    var b = state.buffer; if (!b) return;
    $('clipInfo').textContent = fmtTime(b.duration) + ' · ' + b.sampleRate + ' Hz · ' +
      (b.numberOfChannels === 1 ? 'mono' : b.numberOfChannels + ' canali');
    $('totTime').textContent = fmtTime(b.duration);
    var hasSel = !!(state.selection && state.selection.end > state.selection.start);
    $('trimBtn').disabled = !hasSel;
    $('deleteBtn').disabled = !hasSel;
    $('selClearBtn').disabled = !hasSel;
  }

  // ---- Selezione con mouse/touch sulla waveform ----
  var selDragging = false, selAnchor = 0;
  function xToSec(clientX) {
    var r = canvas.getBoundingClientRect();
    var ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return ratio * state.buffer.duration;
  }
  if (canvas) {
    canvas.addEventListener('pointerdown', function (e) {
      if (!state.buffer) return;
      selDragging = true;
      try { canvas.setPointerCapture(e.pointerId); } catch (er) {}
      selAnchor = xToSec(e.clientX);
      state.selection = { start: selAnchor, end: selAnchor };
      updateSelectionOverlay();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!selDragging) return;
      var p = xToSec(e.clientX);
      state.selection = { start: Math.min(selAnchor, p), end: Math.max(selAnchor, p) };
      updateSelectionOverlay();
    });
    var endSel = function () {
      if (!selDragging) return;
      selDragging = false;
      if (state.selection && (state.selection.end - state.selection.start) < 0.02) state.selection = null;
      updateSelectionOverlay(); refreshEditorInfo();
    };
    canvas.addEventListener('pointerup', endSel);
    canvas.addEventListener('pointercancel', endSel);
  }

  $('selClearBtn').addEventListener('click', function () {
    state.selection = null; updateSelectionOverlay(); refreshEditorInfo();
  });
  $('trimBtn').addEventListener('click', function () {
    if (!state.selection) return;
    stopPlayback();
    pushHistory();
    state.buffer = sliceBuffer(state.buffer, state.selection.start, state.selection.end);
    state.selection = null;
    drawWaveform(); refreshEditorInfo();
    toast('Ritagliata la selezione.', 'success');
  });
  $('deleteBtn').addEventListener('click', function () {
    if (!state.selection) return;
    stopPlayback();
    pushHistory();
    state.buffer = removeRegion(state.buffer, state.selection.start, state.selection.end);
    state.selection = null;
    drawWaveform(); refreshEditorInfo();
    toast('Selezione eliminata.', 'success');
  });
  $('undoBtn').addEventListener('click', function () {
    if (!state.history.length) return;
    stopPlayback();
    state.buffer = state.history.pop();
    state.selection = null;
    $('undoBtn').disabled = state.history.length === 0;
    drawWaveform(); refreshEditorInfo();
  });

  // ---- Volume (master, non distruttivo fino all'export) ----
  var gainInput = $('gain'), gainVal = $('gainVal');
  gainInput.addEventListener('input', function () {
    state.gain = parseInt(gainInput.value, 10) / 100;
    gainVal.textContent = gainInput.value + '%';
    if (playGain) playGain.gain.value = state.gain;
    drawWaveform();
  });

  // ---- Playback ----
  var source = null, playGain = null, playStartCtxTime = 0, playStartOffset = 0, playEndSec = 0, rafId = 0;
  function stopPlayback() {
    if (source) { try { source.onended = null; source.stop(); } catch (e) {} source = null; }
    state.playing = false;
    cancelAnimationFrame(rafId);
    $('playBtn').querySelector('.ic-play').hidden = false;
    $('playBtn').querySelector('.ic-pause').hidden = true;
    if (playheadEl) playheadEl.hidden = true;
  }
  function startPlayback() {
    if (!state.buffer) return;
    var c = ctx(); if (c.state === 'suspended') c.resume();
    stopPlayback();
    var from = 0, to = state.buffer.duration;
    if (state.selection && state.selection.end > state.selection.start) {
      from = state.selection.start; to = state.selection.end;
    }
    source = c.createBufferSource(); source.buffer = state.buffer;
    playGain = c.createGain(); playGain.gain.value = state.gain;
    source.connect(playGain); playGain.connect(c.destination);
    playStartCtxTime = c.currentTime; playStartOffset = from; playEndSec = to;
    source.start(0, from, to - from);
    state.playing = true;
    $('playBtn').querySelector('.ic-play').hidden = true;
    $('playBtn').querySelector('.ic-pause').hidden = false;
    playheadEl.hidden = false;
    source.onended = function () { if (state.playing) stopPlayback(); };
    tickPlayhead();
  }
  function tickPlayhead() {
    if (!state.playing) return;
    var pos = playStartOffset + (ctx().currentTime - playStartCtxTime);
    if (pos >= playEndSec) { stopPlayback(); return; }
    $('curTime').textContent = fmtTime(pos);
    playheadEl.style.left = (pos / state.buffer.duration * 100) + '%';
    rafId = requestAnimationFrame(tickPlayhead);
  }
  $('playBtn').addEventListener('click', function () {
    if (state.playing) stopPlayback(); else startPlayback();
  });

  /* ------------------------------------------------------------------ *
   *  Caricamento file & registrazione
   * ------------------------------------------------------------------ */
  function showWorkspace() {
    editorPanel.hidden = false; transcribePanel.hidden = false; exportPanel.hidden = false;
  }

  async function loadArrayBuffer(ab, name) {
    try {
      var decoded = await ctx().decodeAudioData(ab.slice(0));
      state.buffer = decoded;
      state.filename = (name || 'audio').replace(/\.[^.]+$/, '');
      state.selection = null; state.history = []; state.gain = 1;
      gainInput.value = 100; gainVal.textContent = '100%';
      $('undoBtn').disabled = true;
      showWorkspace();
      drawWaveform(); refreshEditorInfo();
      $('curTime').textContent = '0:00';
      toast('Audio caricato.', 'success');
    } catch (err) {
      console.error(err);
      toast('Impossibile decodificare questo file audio nel browser. Prova con MP3 o WAV.', 'error');
    }
  }

  function handleFiles(files) {
    var f = files[0]; if (!f) return;
    var reader = new FileReader();
    reader.onload = function () { loadArrayBuffer(reader.result, f.name); };
    reader.onerror = function () { toast('Errore nella lettura del file.', 'error'); };
    reader.readAsArrayBuffer(f);
  }

  // Dropzone
  (function () {
    var zone = $('dropzone'), input = $('fileInput');
    zone.addEventListener('click', function () { input.click(); });
    zone.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', function () { if (input.files.length) handleFiles(Array.from(input.files)); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('is-drag'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { zone.addEventListener(ev, function (e) {
      e.preventDefault();
      if (ev === 'dragleave' && zone.contains(e.relatedTarget)) return;
      zone.classList.remove('is-drag');
    }); });
    zone.addEventListener('drop', function (e) {
      var files = Array.from(e.dataTransfer.files);
      if (files.length) handleFiles(files);
    });
  })();

  $('editorReset').addEventListener('click', function () {
    stopPlayback();
    state.buffer = null; state.selection = null; state.history = [];
    editorPanel.hidden = true; transcribePanel.hidden = true; exportPanel.hidden = true;
    clearTranscript();
  });

  // Registrazione microfono
  (function () {
    var recBtn = $('recordBtn'), recTime = $('recordTime'), recLabel = $('recordLabel');
    var mediaRecorder = null, chunks = [], stream = null, recStart = 0, recTimer = 0;

    function tick() {
      var s = Math.floor((Date.now() - recStart) / 1000);
      recTime.textContent = fmtTime(s);
      recTimer = setTimeout(tick, 250);
    }
    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        toast('Permesso microfono negato o non disponibile.', 'error'); return;
      }
      chunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
      mediaRecorder.onstop = function () {
        clearTimeout(recTimer);
        var blob = new Blob(chunks, { type: chunks[0] ? chunks[0].type : 'audio/webm' });
        blob.arrayBuffer().then(function (ab) { loadArrayBuffer(ab, 'registrazione'); });
        if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      };
      mediaRecorder.start();
      recStart = Date.now(); tick();
      recBtn.classList.add('is-recording'); recLabel.textContent = 'Ferma registrazione'; recTime.hidden = false;
    }
    function stop() {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      recBtn.classList.remove('is-recording'); recLabel.textContent = 'Registra dal microfono';
    }
    recBtn.addEventListener('click', function () {
      if (mediaRecorder && mediaRecorder.state === 'recording') stop(); else start();
    });
    if (!navigator.mediaDevices || !window.MediaRecorder) { recBtn.disabled = true; recLabel.textContent = 'Registrazione non supportata'; }
  })();

  /* ------------------------------------------------------------------ *
   *  Export WAV / MP3
   * ------------------------------------------------------------------ */
  function encodeWAV(buf, gain) {
    var numCh = buf.numberOfChannels, sr = buf.sampleRate, len = buf.length;
    var blockAlign = numCh * 2, dataSize = len * blockAlign;
    var ab = new ArrayBuffer(44 + dataSize), view = new DataView(ab);
    function wstr(off, str) { for (var i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); }
    wstr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true); view.setUint32(28, sr * blockAlign, true); view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true);
    wstr(36, 'data'); view.setUint32(40, dataSize, true);
    var chans = []; for (var ch = 0; ch < numCh; ch++) chans.push(buf.getChannelData(ch));
    var offset = 44;
    for (var i = 0; i < len; i++) {
      for (var c = 0; c < numCh; c++) {
        var s = chans[c][i] * gain; s = Math.max(-1, Math.min(1, s));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true); offset += 2;
      }
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  $('exportWavBtn').addEventListener('click', function () {
    if (!state.buffer) return;
    var btn = this; setBusy(btn, true);
    setTimeout(function () {
      try {
        var blob = encodeWAV(state.buffer, state.gain);
        downloadBlob(blob, state.filename + '-editato.wav');
      } catch (e) { console.error(e); toast('Errore export WAV.', 'error'); }
      setBusy(btn, false);
    }, 20);
  });

  var ffmpeg = null;
  async function getFFmpeg() {
    if (ffmpeg) return ffmpeg;
    await loadScript('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js');
    await loadScript('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/umd/util.js');
    var FFmpeg = window.FFmpegWASM.FFmpeg;
    var toBlobURL = window.FFmpegUtil.toBlobURL;
    ffmpeg = new FFmpeg();
    var base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd';
    await ffmpeg.load({
      coreURL: await toBlobURL(base + '/ffmpeg-core.js', 'text/javascript'),
      wasmURL: await toBlobURL(base + '/ffmpeg-core.wasm', 'application/wasm')
    });
    return ffmpeg;
  }

  $('exportMp3Btn').addEventListener('click', function () {
    if (!state.buffer) return;
    var btn = this; setBusy(btn, true);
    (async function () {
      try {
        var f = await getFFmpeg();
        var wav = encodeWAV(state.buffer, state.gain);
        await f.writeFile('in.wav', new Uint8Array(await wav.arrayBuffer()));
        await f.exec(['-i', 'in.wav', '-b:a', '192k', 'out.mp3']);
        var data = await f.readFile('out.mp3');
        downloadBlob(new Blob([data.buffer], { type: 'audio/mpeg' }), state.filename + '-editato.mp3');
      } catch (err) {
        console.error(err);
        toast('MP3 non disponibile ora (serve connessione al primo uso). Usa il WAV.', 'error');
      }
      setBusy(btn, false);
    })();
  });

  /* ================================================================== *
   *  TRASCRIZIONE (Whisper in Web Worker)
   * ================================================================== */
  var worker = null, segments = [];

  function clearTranscript() {
    segments = [];
    $('transcript').innerHTML = '';
    $('transcriptArea').hidden = true;
    $('modelProgress').hidden = true;
  }

  async function toMono16k(buf, gain) {
    var length = Math.max(1, Math.ceil(buf.duration * 16000));
    var Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var off = new Off(1, length, 16000);
    var src = off.createBufferSource(); src.buffer = buf;
    var g = off.createGain(); g.gain.value = gain;
    src.connect(g); g.connect(off.destination); src.start();
    var rendered = await off.startRendering();
    return rendered.getChannelData(0);
  }

  function addSegment(seg) {
    segments.push(seg);
    var div = document.createElement('div');
    div.className = 'seg';
    var t = document.createElement('span'); t.className = 'seg-time';
    t.textContent = fmtTime(seg.start);
    t.title = 'Vai a ' + fmtTime(seg.start);
    t.addEventListener('click', function () {
      state.selection = null; updateSelectionOverlay();
      stopPlayback();
      // riproduci dall'inizio del segmento
      var c = ctx(); if (c.state === 'suspended') c.resume();
      source = c.createBufferSource(); source.buffer = state.buffer;
      playGain = c.createGain(); playGain.gain.value = state.gain;
      source.connect(playGain); playGain.connect(c.destination);
      playStartCtxTime = c.currentTime; playStartOffset = Math.min(seg.start, state.buffer.duration); playEndSec = state.buffer.duration;
      source.start(0, playStartOffset); state.playing = true;
      $('playBtn').querySelector('.ic-play').hidden = true;
      $('playBtn').querySelector('.ic-pause').hidden = false;
      playheadEl.hidden = false;
      source.onended = function () { if (state.playing) stopPlayback(); };
      tickPlayhead();
    });
    var txt = document.createElement('span'); txt.className = 'seg-text'; txt.textContent = seg.text;
    div.appendChild(t); div.appendChild(txt);
    $('transcript').appendChild(div);
    $('transcript').scrollTop = $('transcript').scrollHeight;
    $('transcriptCount').textContent = segments.length + (segments.length === 1 ? ' segmento' : ' segmenti');
  }

  function setModelProgress(pct, text) {
    $('modelProgress').hidden = false;
    if (pct != null) $('mpFill').style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (text) $('mpText').textContent = text;
  }

  $('transcribeBtn').addEventListener('click', function () {
    if (!state.buffer) { toast('Carica prima un audio.', 'error'); return; }
    var btn = this; setBusy(btn, true);
    $('transcribeLabel').textContent = 'Trascrizione…';
    clearTranscript();
    $('transcriptArea').hidden = false;
    setModelProgress(3, 'Preparazione del modello…');

    var model = $('modelSel').value;
    var language = $('langSel').value;

    (async function () {
      var audio;
      try {
        audio = await toMono16k(state.buffer, state.gain);
      } catch (e) {
        console.error(e); toast('Errore nella preparazione dell\'audio.', 'error');
        setBusy(btn, false); $('transcribeLabel').textContent = 'Trascrivi audio'; return;
      }

      if (worker) { worker.terminate(); worker = null; }
      try {
        worker = new Worker('whisper.worker.js', { type: 'module' });
      } catch (e) {
        console.error(e); toast('Impossibile avviare il motore di trascrizione.', 'error');
        setBusy(btn, false); $('transcribeLabel').textContent = 'Trascrivi audio'; return;
      }

      worker.onmessage = function (e) {
        var m = e.data || {};
        if (m.type === 'progress') {
          var d = m.data || {};
          if (d.status === 'progress' && d.file) setModelProgress(d.progress || 0, 'Scarico ' + d.file + ' — ' + Math.round(d.progress || 0) + '%');
          else if (d.status === 'ready' || d.status === 'done') setModelProgress(100, 'Modello pronto');
          else if (d.status) setModelProgress(null, d.status + (d.file ? ' — ' + d.file : ''));
        } else if (m.type === 'ready') {
          setModelProgress(100, 'Trascrizione in corso…');
          setTimeout(function () { $('modelProgress').hidden = true; }, 400);
        } else if (m.type === 'segments') {
          (m.segments || []).forEach(addSegment);
        } else if (m.type === 'done') {
          setBusy(btn, false); $('transcribeLabel').textContent = 'Trascrivi audio';
          if (!segments.length) toast('Nessun parlato riconosciuto nell\'audio.', '');
          else toast('Trascrizione completata.', 'success');
        } else if (m.type === 'error') {
          console.error('Worker error:', m.message);
          setBusy(btn, false); $('transcribeLabel').textContent = 'Trascrivi audio';
          $('modelProgress').hidden = true;
          toast('Errore di trascrizione: ' + m.message, 'error');
        }
      };
      worker.onerror = function (err) {
        console.error(err);
        setBusy(btn, false); $('transcribeLabel').textContent = 'Trascrivi audio';
        toast('Errore nel motore di trascrizione (rete necessaria al primo uso).', 'error');
      };

      worker.postMessage({ type: 'transcribe', audio: audio, sampleRate: 16000, model: model, language: language, chunkSec: 20 }, [audio.buffer]);
    })();
  });

  // Copia / download testo
  function fullText() { return segments.map(function (s) { return s.text; }).join(' ').trim(); }
  function toSRT() {
    return segments.map(function (s, i) {
      return (i + 1) + '\n' + fmtSrtTime(s.start) + ' --> ' + fmtSrtTime(s.end) + '\n' + s.text + '\n';
    }).join('\n');
  }

  $('copyTextBtn').addEventListener('click', function () {
    var text = fullText();
    if (!text) { toast('Niente da copiare.', 'error'); return; }
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(function () { toast('Testo copiato negli appunti.', 'success'); setTimeout(showDonateModal, 400); })
      .catch(function () {
        // Fallback
        var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); toast('Testo copiato.', 'success'); setTimeout(showDonateModal, 400); }
        catch (e) { toast('Copia non riuscita.', 'error'); }
        ta.remove();
      });
  });
  $('downloadTxtBtn').addEventListener('click', function () {
    var text = fullText(); if (!text) { toast('Niente da scaricare.', 'error'); return; }
    downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), state.filename + '-trascrizione.txt');
  });
  $('downloadSrtBtn').addEventListener('click', function () {
    if (!segments.length) { toast('Niente da scaricare.', 'error'); return; }
    downloadBlob(new Blob([toSRT()], { type: 'text/plain;charset=utf-8' }), state.filename + '-sottotitoli.srt');
  });

  // Ridisegna la waveform al resize
  var resizeT;
  window.addEventListener('resize', function () { clearTimeout(resizeT); resizeT = setTimeout(function () { if (state.buffer) drawWaveform(); }, 150); });

  /* ================================================================== *
   *  PWA — Service Worker (network-first) + install prompt
   * ================================================================== */
  if ('serviceWorker' in navigator) {
    var hadController = !!navigator.serviceWorker.controller;
    var refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (refreshing) return; refreshing = true;
      if (hadController) window.location.reload();
    });
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
        reg.update();
        var promote = function (sw) { if (sw) sw.postMessage('SKIP_WAITING'); };
        if (reg.waiting) promote(reg.waiting);
        reg.addEventListener('updatefound', function () {
          var nw = reg.installing;
          if (nw) nw.addEventListener('statechange', function () {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) promote(nw);
          });
        });
      }).catch(function (err) { console.warn('SW registration failed:', err); });
    });
  }

  var deferredPrompt = null, installBtn = $('installBtn');
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferredPrompt = e; if (installBtn) installBtn.hidden = false;
  });
  if (installBtn) installBtn.addEventListener('click', function () {
    if (!deferredPrompt) { toast('App già installata o non installabile su questo browser.', ''); return; }
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function (c) {
      if (c.outcome === 'accepted') { toast('VoxScribe installata! Ora funziona offline.', 'success'); installBtn.hidden = true; }
      deferredPrompt = null;
    });
  });
  window.addEventListener('appinstalled', function () { if (installBtn) installBtn.hidden = true; deferredPrompt = null; });
})();

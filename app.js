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
      txt.textContent = '🟢 Audio e testo elaborati solo sul dispositivo';
    } else {
      pill.classList.add('offline');
      txt.textContent = '✈️ Offline — serve un modello e un motore già scaricati per questa modalità';
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
    audioKey: null,
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
    markAudioEdited();
    // Large recordings must not accumulate gigabytes of undo buffers.
    var bytes = state.buffer.length * state.buffer.numberOfChannels * 4;
    if (bytes <= 64 * 1024 * 1024) state.history.push(state.buffer);
    while (state.history.reduce(function (n, b) { return n + b.length * b.numberOfChannels * 4; }, 0) > 64 * 1024 * 1024) state.history.shift();
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
      // Bound redraw work independently of recording duration (preview envelope).
      for (var i = 0; i < samplesPerPx; i += Math.max(1, Math.floor(samplesPerPx / 128))) {
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
    markAudioEdited();
    stopPlayback();
    state.buffer = state.history.pop();
    state.selection = null;
    $('undoBtn').disabled = state.history.length === 0;
    drawWaveform(); refreshEditorInfo();
  });

  // ---- Volume (master, non distruttivo fino all'export) ----
  var gainInput = $('gain'), gainVal = $('gainVal');
  gainInput.addEventListener('input', function () {
    invalidateTranscription();
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

  var audioLoadTicket = 0, loadingAudio = false;
  async function loadArrayBuffer(ab, name, key, ticket) {
    ticket = ticket || ++audioLoadTicket;
    try {
      var Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      // Decode directly at the ASR sample rate, without cloning the compressed file.
      var decoded = await new Off(1, 1, 16000).decodeAudioData(ab);
      if (ticket !== audioLoadTicket) return;
      if (decoded.duration > 7200.1) throw new Error('Durata massima supportata: 2 ore. Dividi il file in parti più brevi.');
      if (decoded.numberOfChannels > 1) {
        var mono = makeBuffer(1, decoded.length, 16000), data = mono.getChannelData(0);
        for (var ch = 0; ch < decoded.numberOfChannels; ch++) {
          var channel = decoded.getChannelData(ch);
          for (var n = 0; n < data.length; n++) data[n] += channel[n] / decoded.numberOfChannels;
        }
        decoded = mono;
      }
      invalidateTranscription(); stopPlayback();
      state.buffer = decoded; state.audioKey = key || null;
      state.filename = (name || 'audio').replace(/\.[^.]+$/, '');
      state.selection = null; state.history = []; state.gain = 1;
      gainInput.value = 100; gainVal.textContent = '100%';
      $('undoBtn').disabled = true;
      showWorkspace();
      drawWaveform(); refreshEditorInfo();
      $('curTime').textContent = '0:00';
      toast('Audio caricato.', 'success');
      refreshRecovery();
    } catch (err) {
      console.error(err);
      if (ticket === audioLoadTicket) toast('Caricamento fallito: ' + err.message + ' Per registrazioni lunghe usa un PC con memoria sufficiente e MP3/WAV.', 'error');
    } finally {
      if (ticket === audioLoadTicket) { loadingAudio = false; $('loadStatus').textContent = state.buffer ? 'Audio pronto: mono 16 kHz per contenere la memoria.' : ''; }
    }
  }

  async function handleFiles(files) {
    var f = files[0]; if (!f) return;
    if (running || loadingAudio) { toast('Interrompi il lavoro in corso prima di caricare un altro file.', 'error'); return; }
    if (f.size > 512 * 1024 * 1024) { toast('File oltre 512 MiB: usa un MP3 compresso o dividi la registrazione.', 'error'); return; }
    var ticket = ++audioLoadTicket; loadingAudio = true;
    invalidateTranscription(); stopPlayback(); state.buffer = null; state.history = []; state.audioKey = null;
    editorPanel.hidden = true; transcribePanel.hidden = true; exportPanel.hidden = true;
    $('loadStatus').textContent = 'Lettura e preparazione locale… Per audio lunghi può richiedere tempo.';
    try {
      var key = await VoxASR.fingerprint(f);
      if (ticket !== audioLoadTicket) return;
      await loadArrayBuffer(await f.arrayBuffer(), f.name, key, ticket);
    } catch (e) { loadingAudio = false; $('loadStatus').textContent = 'Caricamento fallito: ' + e.message; }
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
    audioLoadTicket++; invalidateTranscription(); state.audioKey = null;
    engine.cancel(); // An explicit reset also releases the resident model.
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
      if (running || loadingAudio) { toast('Attendi la fine del lavoro in corso.', 'error'); return; }
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
  var segments = [];

  function clearTranscript() {
    segments = [];
    $('transcript').innerHTML = '';
    $('transcriptArea').hidden = true;
    $('modelProgress').hidden = true;
    $('transcriptCount').textContent = '0 segmenti';
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

  function fmtMB(n) { return (n / 1048576).toFixed(1) + ' MB'; }

  // Aggiorna la barra. { pct } → determinata; { indeterminate:true } → animata
  // (usata quando Hugging Face non invia Content-Length e il totale è ignoto).
  function setMp(opts) {
    $('modelProgress').hidden = false;
    var fill = $('mpFill'), bar = fill.parentElement;
    if (opts.indeterminate) { bar.classList.add('indeterminate'); }
    else if (opts.pct != null) { bar.classList.remove('indeterminate'); fill.style.width = Math.max(0, Math.min(100, opts.pct)) + '%'; }
    if (opts.text != null) $('mpText').textContent = opts.text;
  }

  /* ------------------------------------------------------------------ *
   *  Gestione modelli — scarica singolarmente, mostra quelli residenti
   * ------------------------------------------------------------------ */
  var MODELS = VoxASR.MODELS;
  var selectedModel = MODELS[0].id;
  var engine = new VoxASR.Engine(function () { return new Worker('whisper.worker.js?v=lectures-1', { type: 'module' }); });
  var activeJob = null, running = false, generation = 0, pauseRequested = false;
  var lockedControls = [], wakeLock = null, storageFailed = false;
  function savedJob() { try { return VoxASR.readCheckpoint(localStorage); } catch (_) { return null; } }
  function refreshRecovery() {
    var saved = savedJob();
    var matches = saved && state.audioKey && saved.key === state.audioKey && Math.abs(saved.duration - state.buffer.duration) < 0.01;
    $('restoreBtn').hidden = !matches;
    $('forgetBtn').hidden = !saved;
    $('recoveryNote').textContent = saved
      ? (matches ? 'Risultato salvato su questo dispositivo: ' + fmtTime(saved.next) + ' / ' + fmtTime(saved.duration) + '. Riprendi o esporta il testo.'
        : 'Esiste una trascrizione salvata localmente. Ricarica lo stesso file originale per recuperarla, oppure cancellala.')
      : 'Il salvataggio locale conserva solo testo, impostazioni e avanzamento, mai il file audio. Puoi cancellarlo qui.';
    if (state.buffer && !state.audioKey) $('recoveryNote').textContent = 'Per recuperare questo audio registrato o modificato dopo la chiusura, esportalo in WAV e ricaricalo come file prima di trascrivere. In questa sessione puoi usare pausa/ripresa ed esportare il testo.';
  }
  function setAsrBusy(value) {
    running = value;
    if (value) {
      lockedControls = [];
      ['transcribeBtn','langSel','engineSel','preloadBtn','modelSelect','editorReset','gain','trimBtn','deleteBtn','undoBtn','recordBtn','fileInput','restoreBtn','forgetBtn','saveLocal'].forEach(function (id) {
        var e = $(id); lockedControls.push([e, e.disabled]); e.disabled = true;
      });
    } else {
      lockedControls.forEach(function (pair) { pair[0].disabled = pair[1]; }); lockedControls = [];
    }
    $('pauseBtn').hidden = !value || !activeJob;
    $('stopBtn').hidden = !value;
    $('pauseBtn').disabled = false;
    $('transcribeLabel').textContent = value ? 'Trascrizione…' : (activeJob && activeJob.next < activeJob.duration ? 'Riprendi trascrizione' : 'Trascrivi audio');
  }
  async function keepAwake() {
    try {
      if (navigator.wakeLock && document.visibilityState === 'visible') {
        var lock = await navigator.wakeLock.request('screen');
        if (!running) { lock.release().catch(function () {}); return; }
        wakeLock = lock; lock.addEventListener('release', function () { if (wakeLock === lock) wakeLock = null; });
      }
    } catch (_) {}
  }
  function releaseWake() { if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; } }
  document.addEventListener('visibilitychange', function () { if (running && !wakeLock) keepAwake(); });
  window.addEventListener('beforeunload', function (e) { if (running) { e.preventDefault(); e.returnValue = ''; } });
  function saveProgress() {
    if (!$('saveLocal').checked || !activeJob || !state.audioKey) return;
    try {
      localStorage.setItem(VoxASR.CHECKPOINT, JSON.stringify(Object.assign({}, activeJob, { version: VoxASR.VERSION, key: state.audioKey, gain: state.gain, segments: segments })));
      $('recoveryNote').textContent = 'Testo salvato solo su questo dispositivo fino a ' + fmtTime(activeJob.next) + '.';
    } catch (_) {
      if (!storageFailed) toast('Salvataggio locale non disponibile o spazio esaurito. Esporta il testo prima di chiudere.', 'error');
      storageFailed = true;
      $('recoveryNote').textContent = 'Salvataggio locale fallito: esporta TXT/SRT per conservare i risultati.';
    }
  }
  function invalidateTranscription() {
    generation++;
    if (engine.pending) engine.cancel();
    activeJob = null; pauseRequested = false;
    if (running) setAsrBusy(false);
    releaseWake(); clearTranscript();
  }
  function markAudioEdited() {
    invalidateTranscription(); state.audioKey = null;
    $('recoveryNote').textContent = 'Audio modificato: pausa/ripresa disponibile in questa sessione. Esporta il testo prima di chiudere; il recupero dopo riapertura richiede un file originale.';
    $('restoreBtn').hidden = true;
  }
  function progressMessage(m) {
    if (m.type === 'ready') $('engineStatus').textContent = 'Motore attivo: ' + (m.device === 'webgpu' ? 'GPU locale' : 'CPU locale');
    if ((m.type === 'ready' || m.type === 'chunk') && activeJob) {
      setMp({ pct: activeJob.next / activeJob.duration * 100, text: 'Elaborazione locale del blocco da ' + fmtTime(activeJob.next) + ' / ' + fmtTime(activeJob.duration) + '…' });
    }
    if (m.type === 'progress') {
      var p = m.data || {};
      setMp({ indeterminate: true, text: p.file ? 'Preparazione modello: ' + p.file + (p.progress != null ? ' · ' + Math.round(p.progress) + '%' : '') : 'Preparazione del modello locale…' });
    }
  }
  async function preloadModel() {
    if (running) return;
    var ticket = ++generation; setAsrBusy(true); $('pauseBtn').hidden = true;
    setMp({ indeterminate: true, text: 'Preparazione del modello…' });
    try {
      var result = await engine.request({ type: 'preload', model: selectedModel, device: $('engineSel').value }, progressMessage);
      if (ticket !== generation) return;
      setMp({ pct: 100, text: 'Modello pronto in memoria. Verifica la modalità offline prima di un uso senza rete.' });
      $('engineStatus').textContent = result.device === 'webgpu' ? 'GPU locale pronta' : 'CPU locale pronta';
    } catch (e) { if (ticket === generation) setMp({ pct: 0, text: 'Preparazione fallita: ' + e.message }); }
    finally { if (ticket === generation) setAsrBusy(false); }
  }
  MODELS.forEach(function (model) {
    var option = document.createElement('option'); option.value = model.id; option.textContent = model.name; $('modelSelect').appendChild(option);
  });
  function updateModelDescription() {
    selectedModel = $('modelSelect').value;
    $('modelDescription').textContent = MODELS.find(function (m) { return m.id === selectedModel; }).desc;
  }
  $('modelSelect').addEventListener('change', updateModelDescription); updateModelDescription();
  $('preloadBtn').addEventListener('click', preloadModel);
  $('pauseBtn').addEventListener('click', function () { pauseRequested = true; this.disabled = true; this.textContent = 'Pausa al termine del blocco…'; });
  $('stopBtn').addEventListener('click', function () {
    generation++; engine.cancel(); saveProgress(); setAsrBusy(false); releaseWake();
    setMp({ pct: activeJob ? activeJob.next / activeJob.duration * 100 : 0, text: 'Interrotto. Il testo completato resta disponibile; puoi riprendere dall’ultimo blocco.' });
  });
  $('forgetBtn').addEventListener('click', function () {
    try { localStorage.removeItem(VoxASR.CHECKPOINT); refreshRecovery(); } catch (_) { toast('Impossibile cancellare il salvataggio locale.', 'error'); }
  });
  $('saveLocal').addEventListener('change', function () {
    if (!this.checked) { try { localStorage.removeItem(VoxASR.CHECKPOINT); } catch (_) {} refreshRecovery(); }
  });
  $('restoreBtn').addEventListener('click', function () {
    var saved = savedJob();
    if (!saved || saved.key !== state.audioKey || Math.abs(saved.duration - state.buffer.duration) > 0.01) return;
    clearTranscript(); saved.segments.forEach(addSegment);
    activeJob = saved; selectedModel = saved.model; $('modelSelect').value = saved.model; updateModelDescription();
    $('langSel').value = saved.language;
    state.gain = Number.isFinite(saved.gain) ? saved.gain : 1;
    gainInput.value = Math.round(state.gain * 100); gainVal.textContent = gainInput.value + '%';
    $('transcriptArea').hidden = false;
    setMp({ pct: saved.next / saved.duration * 100, text: 'Recuperato fino a ' + fmtTime(saved.next) + '. Puoi esportare o riprendere.' });
    setAsrBusy(false); this.hidden = true;
  });
  refreshRecovery();

  $('transcribeBtn').addEventListener('click', async function () {
    if (running || !state.buffer) return;
    var language = $('langSel').value, model = selectedModel;
    if (!activeJob || activeJob.next >= activeJob.duration || activeJob.model !== model || activeJob.language !== language || activeJob.gain !== state.gain) {
      clearTranscript();
      activeJob = { model: model, language: language, next: 0, duration: state.buffer.duration, gain: state.gain };
    }
    var ticket = ++generation, sourceBuffer = state.buffer;
    pauseRequested = false; storageFailed = false; $('pauseBtn').textContent = 'Pausa dopo il blocco';
    $('transcriptArea').hidden = false;
    setAsrBusy(true); keepAwake();
    var started = Date.now(), initialPosition = activeJob.next;
    try {
      while (activeJob.next < activeJob.duration && ticket === generation) {
        var w = VoxASR.windowAt(activeJob.next, activeJob.duration);
        var startSample = Math.round(w.from * VoxASR.RATE), endSample = Math.round(w.to * VoxASR.RATE);
        var audio = new Float32Array(sourceBuffer.getChannelData(0).subarray(startSample, endSample));
        for (var i = 0; i < audio.length; i++) audio[i] = Math.max(-1, Math.min(1, audio[i] * state.gain));
        setMp({ pct: activeJob.next / activeJob.duration * 100, text: 'Trascrizione ' + fmtTime(w.start) + ' – ' + fmtTime(w.end) + ' / ' + fmtTime(activeJob.duration) });
        if (!VoxASR.isSilent(audio)) {
          var result = await engine.request({ type: 'transcribe', model: model, language: language, device: $('engineSel').value, audio: audio }, progressMessage);
          if (ticket !== generation) return;
          VoxASR.appendSegments(segments, VoxASR.segmentsForWindow(result.chunks, w)).forEach(addSegment);
        }
        activeJob.next = w.end; saveProgress();
        var elapsed = (Date.now() - started) / 1000;
        var processed = activeJob.next - initialPosition;
        var eta = processed > 0 ? (activeJob.duration - activeJob.next) * elapsed / processed : 0;
        setMp({ pct: activeJob.next / activeJob.duration * 100, text: fmtTime(activeJob.next) + ' / ' + fmtTime(activeJob.duration) + ' completati · tempo restante stimato ' + fmtTime(eta) });
        if (pauseRequested) break;
        await new Promise(function (resolve) { setTimeout(resolve, 0); });
      }
      if (ticket !== generation) return;
      var done = activeJob.next >= activeJob.duration;
      setMp({ pct: activeJob.next / activeJob.duration * 100, text: done ? 'Trascrizione completata. Rivedi nomi, termini tecnici e interventi sovrapposti prima di usare il testo.' : 'In pausa. Il testo completato è esportabile; riprendi quando vuoi.' });
    } catch (e) {
      if (ticket === generation) setMp({ pct: activeJob.next / activeJob.duration * 100, text: 'Trascrizione interrotta: ' + e.message + ' Il testo precedente è conservato. Puoi riprendere o esportare.' });
    } finally {
      if (ticket === generation) { setAsrBusy(false); releaseWake(); refreshRecovery(); }
    }
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
      if (hadController && !running && !state.buffer && !loadingAudio) window.location.reload();
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

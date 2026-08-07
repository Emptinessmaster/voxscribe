# 🎙️ VoxScribe

**Editor audio + trascrizione automatica (speech-to-text), interamente nel tuo browser.** Registra o carica un audio, tagliane le parti, regola il volume e ottieni una trascrizione con timestamp — **senza che la tua voce lasci il dispositivo**. Zero cloud, funziona anche offline.

> Audio ed elaborazione avvengono in locale: la Web Audio API per l'editing, **Whisper** via **WebAssembly** (ONNX Runtime, tramite Transformers.js) per la trascrizione.

### [▶ Apri VoxScribe](https://emptinessmaster.github.io/voxscribe/)

[![Apri l'applicazione](https://img.shields.io/badge/▶%20Apri%20l'applicazione-VoxScribe-8B5CF6?style=for-the-badge&logo=googlechrome&logoColor=white)](https://emptinessmaster.github.io/voxscribe/)

[![Deploy](https://github.com/Emptinessmaster/voxscribe/actions/workflows/deploy.yml/badge.svg)](https://github.com/Emptinessmaster/voxscribe/actions/workflows/deploy.yml)
![Stack](https://img.shields.io/badge/stack-HTML%20%2B%20CSS%20%2B%20JS-8B5CF6) ![PWA](https://img.shields.io/badge/PWA-offline-22D3EE) ![License](https://img.shields.io/badge/license-MIT-blue)

## ✨ Funzionalità

- **Sorgente** — Drag & drop di file (MP3, WAV, M4A, MP4) o **registrazione dal microfono** (MediaRecorder).
- **Editor forma d'onda** — waveform su canvas, selezione a trascinamento, **ritaglio** ed **eliminazione** di porzioni, **volume**.
- **Trascrizione Whisper** — speech-to-text 100% locale con **timestamp**, segmenti che compaiono progressivamente. Modelli Tiny/Base, rilevamento lingua.
- **Esportazione** — copia il testo, scaricalo come **.TXT** o **.SRT**, ed esporta l'audio editato in **WAV** (sempre) o **MP3** (via FFmpeg.wasm, on-demand).

## 🔒 Privacy-First

- **Elaborazione 100% client-side** — nessun upload, nessun backend.
- **PWA installabile** — Service Worker network-first + manifest: uso **offline** dopo il primo download dei modelli.
- Il modello Whisper viene scaricato una sola volta e messo in cache dal browser.

## 🧰 Stack

- **Vanilla JS** (nessun framework, nessuna build).
- [Transformers.js](https://github.com/xenova/transformers.js) — Whisper via ONNX Runtime Web (WASM).
- **Web Audio API** — decodifica, waveform, editing, encoding WAV.
- [FFmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) — export MP3 (lazy).

## 🚀 Uso in locale

Il Service Worker e i Web Worker richiedono HTTP (non `file://`):

```bash
python -m http.server 8080
```

Poi apri <http://127.0.0.1:8080/>.

## ☕ Sostieni il progetto

- [☕ Buy me a coffee](https://buymeacoffee.com/emptinessmaster)
- [🅿️ PayPal](https://paypal.me/EmptinessMaster)

## 📄 Licenza

[MIT](LICENSE) © 2026 VoxScribe

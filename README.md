# 🎙️ VoxScribe

**Editor audio + trascrizione automatica (speech-to-text), interamente nel tuo browser.** Registra o carica un audio, tagliane le parti, regola il volume e ottieni una trascrizione con timestamp — **senza che la tua voce lasci il dispositivo**. Zero cloud, funziona anche offline.

> Lezioni e assemblee in italiano e inglese, fino a 2 ore per file e 512 MiB di ingresso. Whisper tramite Transformers.js 3.8.1: **WebGPU** quando disponibile, **WebAssembly/CPU** per Small e Base come riserva. Nessun backend e nessun upload dell'audio.

### [▶ Apri VoxScribe](https://emptinessmaster.github.io/voxscribe/)

[![Apri l'applicazione](https://img.shields.io/badge/▶%20Apri%20l'applicazione-VoxScribe-8B5CF6?style=for-the-badge&logo=googlechrome&logoColor=white)](https://emptinessmaster.github.io/voxscribe/)

[![Deploy](https://github.com/Emptinessmaster/voxscribe/actions/workflows/deploy.yml/badge.svg)](https://github.com/Emptinessmaster/voxscribe/actions/workflows/deploy.yml)
![Stack](https://img.shields.io/badge/stack-HTML%20%2B%20CSS%20%2B%20JS-8B5CF6) ![PWA](https://img.shields.io/badge/PWA-offline-22D3EE) ![License](https://img.shields.io/badge/license-MIT-blue)

## ✨ Funzionalità

- **Sorgente** — Drag & drop di file (MP3, WAV, M4A, MP4) o **registrazione dal microfono** (MediaRecorder).
- **Editor forma d'onda** — waveform su canvas, selezione a trascinamento, **ritaglio** ed **eliminazione** di porzioni, **volume**.
- **Trascrizione Whisper** — Small consigliato, Base leggero e Large v3 Turbo per GPU compatibili. Italiano, inglese o rilevamento automatico. Risultati progressivi con timestamp, elaborazione a blocchi e modello riutilizzato in memoria.
- **Pausa e ripresa** — pausa al termine del blocco; interruzione immediata senza perdere i blocchi completati. TXT/SRT esportabili anche prima della fine.
- **Recupero locale** — salvataggio opzionale di una trascrizione alla volta nel browser, senza audio. Ricaricando lo stesso file originale (verificato con hash dell'intero contenuto) puoi recuperare testo e avanzamento. Pulsante per cancellare il salvataggio.
- **Esportazione** — copia il testo, scaricalo come **.TXT** o **.SRT**, ed esporta l'audio editato in **WAV** (sempre) o **MP3** (via FFmpeg.wasm, on-demand).

## 🔒 Privacy-First

- **Elaborazione 100% client-side** — nessun upload, nessun backend.
- **PWA installabile** — Service Worker network-first + manifest: uso **offline** dopo il primo download dei modelli.
- Codice e pesi pubblici vengono scaricati da jsDelivr e Hugging Face: i servizi ricevono le richieste di download, mai l'audio o il testo. I font usano il sistema, senza richieste a Google Fonts.
- La cache dipende dallo spazio disponibile: il browser può eliminarla. Prepara e prova la modalità GPU/CPU desiderata prima di lavorare offline. Gli aggiornamenti dell'app conservano la cache dei modelli e delle altre applicazioni.
- Il salvataggio del testo è locale e non crittografato: disattivalo/cancellalo su dispositivi condivisi. Gli errori di spazio o accesso allo storage vengono segnalati; esporta il testo per conservarlo fuori dal browser.

## 🧰 Stack

- **Vanilla JS** (nessun framework, nessuna build).
- [Transformers.js](https://github.com/huggingface/transformers.js) 3.8.1 — Whisper via ONNX Runtime Web (WebGPU/WASM).
- **Web Audio API** — decodifica, waveform, editing, encoding WAV.
- [FFmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) — export MP3 (lazy).

## 🚀 Uso in locale

Il Service Worker e i Web Worker richiedono HTTP (non `file://`):

```bash
python -m http.server 8080
```

Poi apri <http://127.0.0.1:8080/>.

## Registrazioni lunghe e limiti

L'inferenza riceve al massimo 70 secondi: un minuto di avanzamento e fino a 5 secondi di contesto per lato. Whisper suddivide internamente in finestre da 30 secondi. I timestamp restano riferiti all'audio corrente e le ripetizioni nel parlato non vengono vietate. Solo blocchi quasi digitalmente silenziosi vengono saltati; questo non è un rilevatore neurale del parlato e non rimuove il rumore.

La decodifica iniziale carica ancora l'intero file. Il buffer di lavoro mono 16 kHz occupa circa 439 MiB per due ore, oltre a decoder, modello, runtime e file compresso. Preferisci un PC con memoria sufficiente: il supporto su telefoni non è garantito. Nessuna promessa di trascrizione in tempo reale.

L'editing e l'export audio operano sul buffer mono 16 kHz, quindi non conservano la qualità stereo originale. Per ridurre la memoria la cronologia undo è limitata a 64 MiB: su registrazioni lunghe un taglio può non essere annullabile. Conserva il file originale. Dopo tagli/eliminazioni, la ripresa funziona nella stessa sessione ma non dopo riapertura: esporta il testo o salva l'audio modificato come nuovo file prima di iniziare una trascrizione recuperabile.

Il programma non identifica automaticamente i parlanti. Voci sovrapposte, nomi e lessico specialistico richiedono revisione; controlla anche i confini tra blocchi. Non è stato misurato un tasso di errore su lezioni reali complete di 1–2 ore.

Nelle prove reali brevi in Edge, Base CPU, Small GPU e Turbo GPU hanno trascritto italiano e inglese e superato la riapertura con inferenza offline. I pesi vengono salvati in frammenti da 8 MiB per evitare il fallimento della cache osservato con singoli encoder grandi. La disponibilità offline resta soggetta allo spazio e alle politiche del browser. Il modello rimane in memoria tra file consecutivi, finché non interrompi/resetti il motore o chiudi la pagina.

## Verifica

`node --test tests/transcription.test.cjs` esegue regressioni su timeline di due ore, silenzi, timestamp, ripetizioni, fingerprint, checkpoint, annullamento e isolamento delle cache.

Per le prove browser installa Playwright oppure imposta `VOX_PLAYWRIGHT_PATH` al percorso di una sua installazione. `node tests/browser.cjs` verifica il flusso con inferenza simulata; `node tests/long-browser.cjs` decodifica realmente due ore di silenzio sintetico e completa 120 blocchi. La prova del silenzio non misura l'accuratezza ASR.

`node tests/real-browser.cjs` usa i file locali non inclusi `speech-test.wav` (italiano) e `speech-en.wav` (inglese). Puoi impostare `VOX_REAL_MODEL` e `VOX_REAL_DEVICE` (`auto`/`wasm`). Non carica i file su server: verifica il testo prodotto, l'assenza di richieste di upload e l'inferenza dopo una riapertura offline.

## ☕ Sostieni il progetto

- [☕ Buy me a coffee](https://buymeacoffee.com/emptinessmaster)
- [🅿️ PayPal](https://paypal.me/EmptinessMaster)

## 📄 Licenza

[MIT](LICENSE) © 2026 VoxScribe

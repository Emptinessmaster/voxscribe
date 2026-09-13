# VoxScribe: lezioni e assemblee private

Autorizzazione: applicare le modifiche opportune per trascrizioni locali IT/EN di 1–2 ore.

- whisper.worker.js: Transformers.js 3.8.1, WebGPU/CPU, modelli multilingue, pipeline riutilizzata, richieste seriali.
- transcription.js: blocchi limitati, fingerprint completo del file, checkpoint locale, annullamento, timestamp.
- model-cache.js: cache dei pesi in frammenti da 8 MiB per rendere affidabile il caricamento offline di encoder grandi.
- app.js: mono 16 kHz, memoria undo limitata, risultati progressivi, pausa/ripresa, recupero checkpoint, gestione errori.
- index.html/styles.css: controlli per lezioni/assemblee, privacy del salvataggio locale, accessibilità.
- sw.js: cache isolata, risorse versionate, niente cancellazione dei modelli né reload durante la trascrizione.
- tests/: regressioni per due ore simulate, checkpoint, annullamento, cache e prove browser.
- README.md/system_architecture.md: comportamento, limiti e verifica.

Nessuna API cloud. Nessuna attribuzione automatica dei parlanti senza un modello dedicato e verificato.
Il decoder del browser carica ancora il file: due ore richiedono memoria sufficiente durante la decodifica iniziale.

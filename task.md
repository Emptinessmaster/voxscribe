# Verifica aggiornamento VoxScribe

- [x] Pipeline locale multilingue con Transformers.js aggiornato, WebGPU e CPU.
- [x] Inferenza a blocchi, risultati progressivi, worker riutilizzato.
- [x] Pausa/ripresa, stop immediato, esportazione parziale, recupero locale sullo stesso file.
- [x] Decodifica mono 16 kHz e memoria undo/forma d'onda limitata.
- [x] Cache isolata, privacy del salvataggio e dipendenze documentate.
- [x] Regressioni automatiche e flusso browser con inferenza simulata.
- [x] File reale di due ore di silenzio decodificato e processato in 120 blocchi.
- [x] Inferenza reale breve italiano/inglese: Base CPU, Small GPU e Turbo GPU.
- [x] Cache a frammenti da 8 MiB: regressioni su file incompleti e scritture fallite.
- [x] Riapertura offline e inferenza reale Base CPU, Small GPU e Turbo GPU in Edge.
- [x] Copia delle modifiche nel repository VoxScribe, verificata tramite hash.

Limite della verifica: non è stato trascritto un corpus di lezioni reali di 1–2 ore; non viene dichiarato un tasso di errore o un tempo di elaborazione per quel caso.

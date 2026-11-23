# Reader

A private, offline-first web app that reads English PDF books aloud with sentence and word highlighting.

* Everything runs in the browser. PDFs are stored only on the device (IndexedDB). No server, no analytics.
* Text extraction with pdf.js (vendored), rebuilt into paragraphs and sentences: hyphenation fixed, running headers, footers and page numbers removed.
* Read-aloud with the Web Speech API, one utterance per sentence, word highlight where the engine sends word boundaries.
* Installable PWA (works offline after the first visit).

Third-party code: pdf.js (Apache-2.0), Literata, Frank Ruhl Libre and Rubik fonts (SIL OFL 1.1).

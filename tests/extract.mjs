// Node check of the extraction pipeline: prints sentences for given pages.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs';
globalThis.__pdfjs = pdfjs;
const src = fs.readFileSync(new URL('../js/book.js', import.meta.url), 'utf8')
  .replace(/^import \{[^}]+\} from '\.\/text\.js';/m, "import { buildLines, learnEdges, stripEdges, dominantSize, pageParagraphs, continues, joinText, splitSentences } from '../js/text.js';")
  .replace("pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');", 'pdfjs = globalThis.__pdfjs;')
  .replace("pdfjs.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.mjs';", '');
fs.writeFileSync(new URL('./_book_node.mjs', import.meta.url), src);
const { Book } = await import('./_book_node.mjs');
const [file, from, to] = process.argv.slice(2);
const t0 = Date.now();
const book = await Book.open(new Uint8Array(fs.readFileSync(file)));
console.log('open ms', Date.now() - t0, 'pages', book.numPages, 'title', book.metaTitle, 'body', book.bodySize, 'scanned', book.scanned, 'edges', [...book.edges.keys]);
for (let p = +from; p <= +to; p++) {
  const ss = await book.sentences(p);
  console.log(`=== p${p} (${ss.length})`);
  for (const s of ss) console.log(`${s.id}${s.paraStart ? ' ¶' : ''}${s.heading ? ' H' : ''}${s.pageStart ? ' START' : ''}${s.marks.length ? ' marks=' + JSON.stringify(s.marks) : ''} | ${s.text}`);
}
console.log('outline', JSON.stringify(await book.outline()));

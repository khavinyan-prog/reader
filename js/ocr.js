// Text recognition for scanned pages (pictures of text), with tesseract.js. Loaded only when asked for.
const BASE = new URL('../vendor/tesseract/', import.meta.url).href;
let workerP = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });
}

function getWorker() {
  if (!workerP) {
    workerP = (async () => {
      if (!window.Tesseract) await loadScript(BASE + 'tesseract.min.js');
      return window.Tesseract.createWorker('eng', 1, {
        workerPath: BASE + 'worker.min.js',
        corePath: BASE.replace(/\/$/, ''),
        langPath: BASE + 'lang',
        gzip: true,
      });
    })();
    workerP.catch(() => { workerP = null; });
  }
  return workerP;
}

let chain = Promise.resolve();

// Recognise one page; returns lines in PDF coordinates, the same shape buildLines() produces.
export function ocrPage(book, p) {
  const run = chain.then(async () => {
    const page = await book.pdf.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, 1700 / Math.max(base.width, 1));
    const { canvas } = await book.renderPageToCanvas(p, scale);
    const worker = await getWorker();
    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
    canvas.width = canvas.height = 0;
    const raw = [];
    for (const b of data.blocks || []) {
      for (const para of b.paragraphs || []) {
        (para.lines || []).forEach((ln, i) => {
          const text = (ln.text || '').replace(/\s+/g, ' ').trim();
          if (!text || ln.confidence < 30) return;
          const bb = ln.bbox;
          const h = ln.rowAttributes && ln.rowAttributes.row_height ? ln.rowAttributes.row_height : bb.y1 - bb.y0;
          const baseline = ln.baseline && ln.baseline.y0 ? Math.max(ln.baseline.y0, ln.baseline.y1) : bb.y1;
          raw.push({ text, x: bb.x0 / scale, y: base.height - baseline / scale, right: bb.x1 / scale, size: (h / scale) * 0.8, paraStart: i === 0 });
        });
      }
    }
    // Line heights from OCR jitter; snap ordinary lines to the page's typical size so headings stand out.
    const sizes = raw.map((l) => l.size).sort((a, b) => a - b);
    const med = sizes[Math.floor(sizes.length / 2)] || 10;
    for (const l of raw) {
      if (l.size < med * 1.35) l.size = med;
      l.size = Math.round(l.size * 10) / 10;
    }
    return raw;
  });
  chain = run.catch(() => {});
  return run;
}

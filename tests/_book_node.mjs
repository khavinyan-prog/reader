// A PDF book: lazy, per-page text extraction and a stable sentence model.
// Sentence id = "page:index", where page is the page the sentence starts on.
import { buildLines, learnEdges, stripEdges, dominantSize, pageParagraphs, continues, joinText, splitSentences } from '../js/text.js';

let pdfjs = null;
const VENDOR = new URL('../vendor/pdfjs/', import.meta.url).href;

async function lib() {
  if (!pdfjs) {
    pdfjs = globalThis.__pdfjs;
    
  }
  return pdfjs;
}

export class Book {
  static async open(data) {
    const pdfjsLib = await lib();
    const task = pdfjsLib.getDocument({
      data,
      cMapUrl: VENDOR + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: VENDOR + 'standard_fonts/',
      wasmUrl: VENDOR + 'wasm/',
      isEvalSupported: false,
      enableXfa: false,
    });
    const pdf = await task.promise;
    const book = new Book(pdf);
    await book.init();
    return book;
  }

  constructor(pdf) {
    this.pdf = pdf;
    this.numPages = pdf.numPages;
    this.id = (pdf.fingerprints && pdf.fingerprints[0]) || String(Date.now());
    this.rawCache = new Map(); // page -> Promise<lines>
    this.infoCache = new Map(); // page -> Promise<info>
    this.sentCache = new Map(); // page -> Promise<sentences>
    this.ready = new Map(); // page -> sentences (sync access)
    this.ocrPages = new Map(); // page -> lines from OCR
    this.edges = null;
    this.bodySize = 10;
  }

  async init() {
    const n = this.numPages;
    const sample = new Set();
    const count = Math.min(n, 24);
    for (let i = 0; i < count; i++) sample.add(1 + Math.round((i * (n - 1)) / Math.max(1, count - 1)));
    const pages = [...sample];
    const lines = await Promise.all(pages.map((p) => this.rawLines(p)));
    this.edges = learnEdges(lines);
    this.bodySize = dominantSize(lines);
    const withText = lines.filter((ls) => ls.reduce((a, l) => a + l.text.length, 0) > 30).length;
    this.scanned = lines.length > 0 && withText / lines.length < 0.25;
    this.sampleTextRatio = lines.length ? withText / lines.length : 0;
    let meta = null;
    try { meta = await this.pdf.getMetadata(); } catch { /* no metadata */ }
    this.metaTitle = cleanTitle(meta && meta.info && meta.info.Title);
    this.author = (meta && meta.info && typeof meta.info.Author === 'string' && meta.info.Author.trim()) || '';
  }

  async rawLines(p) {
    if (p < 1 || p > this.numPages) return null;
    if (!this.rawCache.has(p)) {
      this.rawCache.set(p, (async () => {
        if (this.ocrPages.has(p)) return this.ocrPages.get(p);
        const page = await this.pdf.getPage(p);
        const tc = await page.getTextContent({ includeMarkedContent: false });
        page.cleanup();
        return buildLines(tc.items);
      })().catch(() => []));
    }
    return this.rawCache.get(p);
  }

  async info(p) {
    if (p < 1 || p > this.numPages) return null;
    if (!this.infoCache.has(p)) {
      this.infoCache.set(p, (async () => {
        const [l2, l1, l0, r1, r2] = await Promise.all([p - 2, p - 1, p, p + 1, p + 2].map((q) => this.rawLines(q)));
        const lines = stripEdges(l0 || [], this.edges, [l2, l1, r1, r2], this.bodySize);
        const res = pageParagraphs(lines, { bodySize: this.bodySize });
        res.chars = (l0 || []).reduce((a, l) => a + l.text.length, 0);
        return res;
      })());
    }
    return this.infoCache.get(p);
  }

  // Sentences that start on page p.
  sentences(p) {
    if (p < 1 || p > this.numPages) return Promise.resolve([]);
    if (!this.sentCache.has(p)) {
      const pr = this.buildSentences(p).then((ss) => { this.ready.set(p, ss); return ss; });
      this.sentCache.set(p, pr);
    }
    return this.sentCache.get(p);
  }

  async buildSentences(p) {
    const me = await this.info(p);
    if (!me.paras.length) return [];
    let first = p;
    while (first > 1 && p - first < 3) {
      const a = await this.info(first - 1);
      const b = await this.info(first);
      if (!continues(a, b)) break;
      first--;
    }
    let last = p;
    while (last < this.numPages && last - p < 3) {
      const a = await this.info(last);
      const b = await this.info(last + 1);
      if (!continues(a, b)) break;
      last++;
    }
    // Merge paragraphs across [first..last]; each keeps where every page begins inside it.
    const paras = [];
    let prevInfo = null;
    for (let q = first; q <= last; q++) {
      const inf = await this.info(q);
      inf.paras.forEach((para, i) => {
        if (i === 0 && q > first && continues(prevInfo, inf) && paras.length) {
          const P = paras[paras.length - 1];
          const j = joinText(P.text, para.text);
          P.text = j.text;
          P.marks.push({ at: j.at, page: q });
        } else {
          paras.push({ text: para.text, heading: para.heading, page: q, marks: [] });
        }
      });
      prevInfo = inf;
    }
    const out = [];
    const entry = paras.find((P) => P.marks.some((mk) => mk.page === p));
    for (const P of paras) {
      const ranges = P.heading ? [{ start: 0, end: P.text.length }] : splitSentences(P.text);
      ranges.forEach((r, k) => {
        let page = P.page;
        for (const mk of P.marks) if (mk.at <= r.start) page = mk.page;
        if (page !== p) return;
        const inner = P.marks.filter((mk) => mk.at > r.start && mk.at < r.end).map((mk) => ({ off: Math.min(wordEnd(P.text, mk.at), r.end) - r.start, page: mk.page }));
        let pageStart = false;
        if (!out.length) {
          if (!entry) pageStart = true;
          else if (entry === P) {
            const mk = P.marks.find((x) => x.page === p);
            pageStart = !P.text.slice(mk.at, r.start).trim();
          }
        }
        out.push({ text: P.text.slice(r.start, r.end), paraStart: k === 0, heading: P.heading, marks: inner, pageStart });
      });
    }
    out.forEach((s, i) => { s.page = p; s.idx = i; s.id = p + ':' + i; });
    return out;
  }

  sentenceSync(id) {
    const [p, i] = id.split(':').map(Number);
    const ss = this.ready.get(p);
    return ss ? ss[i] || null : null;
  }

  async sentence(id) {
    const [p, i] = id.split(':').map(Number);
    const ss = await this.sentences(p);
    return ss[i] || null;
  }

  async nextId(id, dir = 1) {
    let [p, i] = id.split(':').map(Number);
    const ss = await this.sentences(p);
    if (dir > 0 && i + 1 < ss.length) return p + ':' + (i + 1);
    if (dir < 0 && i - 1 >= 0) return p + ':' + Math.min(i - 1, ss.length - 1);
    for (let q = p + dir; q >= 1 && q <= this.numPages; q += dir) {
      const s2 = await this.sentences(q);
      if (s2.length) return q + ':' + (dir > 0 ? 0 : s2.length - 1);
    }
    return null;
  }

  async firstIdFrom(page) {
    for (let q = Math.max(1, page); q <= this.numPages; q++) {
      const ss = await this.sentences(q);
      if (ss.length) return q + ':0';
    }
    return null;
  }

  async outline() {
    let items = null;
    try { items = await this.pdf.getOutline(); } catch { items = null; }
    if (!items || !items.length) return [];
    const out = [];
    const walk = async (list, depth) => {
      for (const it of list) {
        let page = null;
        try {
          let dest = it.dest;
          if (typeof dest === 'string') dest = await this.pdf.getDestination(dest);
          if (Array.isArray(dest) && dest[0] != null) {
            page = typeof dest[0] === 'number' ? dest[0] + 1 : (await this.pdf.getPageIndex(dest[0])) + 1;
          }
        } catch { page = null; }
        const title = (it.title || '').replace(/\s+/g, ' ').trim();
        if (title && page) out.push({ title, page, depth });
        if (it.items && it.items.length && depth < 2) await walk(it.items, depth + 1);
      }
    };
    await walk(items, 0);
    return out;
  }

  async renderPageToCanvas(p, scale) {
    const page = await this.pdf.getPage(p);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
    return { canvas, height: vp.height, scale };
  }

  // Replace a page's text with OCR lines (PDF coordinates) and drop caches that depend on it.
  setOcrLines(p, lines) {
    this.ocrPages.set(p, lines);
    for (const q of [p - 2, p - 1, p, p + 1, p + 2]) { this.rawCache.delete(q); this.infoCache.delete(q); }
    for (const q of [p - 4, p - 3, p - 2, p - 1, p, p + 1, p + 2, p + 3, p + 4]) { this.sentCache.delete(q); this.ready.delete(q); }
  }

  destroy() {
    try { this.pdf.destroy(); } catch { /* ignore */ }
  }
}

function wordEnd(text, at) {
  // Page markers sit after the word that crosses the page edge.
  let i = at;
  while (i < text.length && !/\s/.test(text[i])) i++;
  return i;
}

function cleanTitle(t) {
  if (typeof t !== 'string') return '';
  let s = t.replace(/^Microsoft (Word|PowerPoint) - /i, '').replace(/\.(docx?|indd|pdf|rtf|txt|odt)$/i, '').trim();
  if (s.length < 2 || /^(untitled|unknown|title|document|book|\d+)$/i.test(s)) return '';
  return s;
}

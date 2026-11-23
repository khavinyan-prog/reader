// Pure text helpers: turn pdf.js text items into clean lines, paragraphs and sentences.
// No DOM here, so the same code runs in the browser and in Node tests.

const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };

export function cleanText(s) {
  return s
    .replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c])
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/[\t\n\r   -   　]/g, ' ')
    .replace(/‐|‑/g, '-')
    .replace(/ {2,}/g, ' ');
}

function itemSize(it) {
  const t = it.transform;
  return Math.hypot(t[2], t[3]) || it.height || 0;
}

// Group text items (stream order) into visual lines.
export function buildLines(items) {
  const lines = [];
  let cur = null;
  let space = false;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const raw = it.str;
    if (!raw.trim()) {
      if (raw.length) space = true;
      if (it.hasEOL) space = true;
      continue;
    }
    const x = it.transform[4];
    const y = it.transform[5];
    const size = itemSize(it);
    const w = it.width || 0;
    const tol = Math.max(1.5, 0.45 * (cur ? Math.min(size || cur.size, cur.size || size) : size));
    const sameLine = cur && Math.abs(y - cur.y) <= tol && x >= cur.right - Math.max(2, size * 1.2);
    if (sameLine) {
      const gap = x - cur.right;
      const needSpace = space || gap > 0.18 * Math.max(size, 1);
      if (needSpace && !/\s$/.test(cur.text) && !/^\s/.test(raw)) cur.text += ' ';
      cur.text += raw;
      cur.right = Math.max(cur.right, x + w);
      if (raw.length > cur.mainLen) { cur.mainLen = raw.length; cur.size = size; }
    } else {
      cur = { text: raw, x, y, right: x + w, size, mainLen: raw.length };
      lines.push(cur);
    }
    space = !!it.hasEOL;
  }
  const out = [];
  for (const l of lines) {
    const text = cleanText(l.text).trim();
    if (!text) continue;
    out.push({ text, x: l.x, y: l.y, right: l.right, size: Math.round(l.size * 10) / 10 });
  }
  // Some PDFs draw text bottom-up; if most steps go up, sort top-down.
  let up = 0, down = 0;
  for (let i = 1; i < out.length; i++) {
    if (out[i].y > out[i - 1].y + 1) up++; else if (out[i].y < out[i - 1].y - 1) down++;
  }
  if (up > down * 2 && up > 3) out.sort((a, b) => b.y - a.y || a.x - b.x);
  return out;
}

const NUMBER_ONLY = /^(?:page\s*)?(?:[-–—·•]\s*)?(?:\d{1,4}|[ivxlcdm]{1,7})(?:\s*[-–—·•])?$/i;

export function edgeKey(text) {
  return text.toLowerCase().replace(/[^a-zÀ-ɏ]+/g, ' ').replace(/\b[ivxlcdm]+\b/g, ' ').replace(/\s+/g, ' ').trim();
}

// Indices of the top 2 and bottom 2 lines by vertical position.
export function edgeIndices(lines) {
  if (!lines.length) return [];
  const order = lines.map((l, i) => i).sort((a, b) => lines[b].y - lines[a].y);
  const set = new Set([order[0], order[1], order[order.length - 1], order[order.length - 2]].filter((i) => i !== undefined));
  return [...set];
}

// Build the book-wide model of running headers/footers from a sample of pages.
export function learnEdges(samplePages) {
  const counts = new Map();
  let n = 0;
  for (const lines of samplePages) {
    if (!lines || !lines.length) continue;
    n++;
    const seen = new Set();
    for (const i of edgeIndices(lines)) {
      const k = edgeKey(lines[i].text);
      if (k.length < 3) continue;
      const key = k + '@' + Math.round(lines[i].y / 6);
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const need = n >= 6 ? Math.max(3, Math.ceil(n * 0.15)) : Math.max(2, Math.ceil(n * 0.5));
  const keys = new Set();
  for (const [k, c] of counts) if (c >= need) keys.add(k);
  return { keys, sampled: n };
}

// Remove page numbers and running headers/footers. neighbours: lines of pages p-2..p+2 (may be null).
export function stripEdges(lines, edges, neighbours, bodySize) {
  const drop = new Set();
  const idx = edgeIndices(lines);
  for (const i of idx) {
    const l = lines[i];
    if (bodySize && l.size > bodySize * 1.15) continue; // chapter titles, never running heads
    if (NUMBER_ONLY.test(l.text)) { drop.add(i); continue; }
    const k = edgeKey(l.text);
    if (k.length >= 3 && edges && edges.keys.has(k + '@' + Math.round(l.y / 6))) { drop.add(i); continue; }
    if (k.length >= 3 && edges && (edges.keys.has(k + '@' + (Math.round(l.y / 6) + 1)) || edges.keys.has(k + '@' + (Math.round(l.y / 6) - 1)))) { drop.add(i); continue; }
    // Local repetition: same text at the same height on a nearby page (chapter running heads).
    if (k.length >= 3 && neighbours) {
      const exact = l.text.replace(/\d+/g, '#').toLowerCase();
      for (const nb of neighbours) {
        if (!nb) continue;
        if (edgeIndices(nb).some((j) => Math.abs(nb[j].y - l.y) < 2.5 && nb[j].text.replace(/\d+/g, '#').toLowerCase() === exact)) { drop.add(i); break; }
      }
    }
  }
  return drop.size ? lines.filter((l, i) => !drop.has(i)) : lines;
}

function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

function mode(arr, step) {
  const m = new Map();
  let best = null, bestC = 0;
  for (const v of arr) {
    const k = Math.round(v / step);
    const c = (m.get(k) || 0) + 1;
    m.set(k, c);
    if (c > bestC || (c === bestC && k < best)) { best = k; bestC = c; }
  }
  return best === null ? 0 : best * step;
}

// Most common font size, weighted by characters.
export function dominantSize(pagesLines) {
  const w = new Map();
  for (const lines of pagesLines) for (const l of lines || []) {
    const k = Math.round(l.size * 2) / 2;
    w.set(k, (w.get(k) || 0) + l.text.length);
  }
  let best = 0, bc = -1;
  for (const [k, c] of w) if (c > bc) { best = k; bc = c; }
  return best || 10;
}

const TERMINAL = /[.!?…]["'”’)\]]*$/;
const OPEN_END = /[-­]$/;
const HEADING_WORD = /^(chapter|part|book|section|prologue|epilogue|preface|foreword|introduction|afterword|contents|appendix)\b[\s.:]*([0-9ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[a-z]+teen|twenty[a-z-]*|thirty[a-z-]*|forty[a-z-]*|fifty[a-z-]*)?\b/i;

const COMPOUND_LEFT = new Set(['self', 'well', 'ill', 'half', 'all', 'cross', 'non', 'great', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'brother', 'sister', 'father', 'mother', 'daughter', 'son', 'old', 'so', 'far', 'ever', 'long', 'short', 'first', 'second', 'third', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']);

// Join two pieces of text that were on consecutive lines. Returns joined text and where b starts.
export function joinText(a, b) {
  if (!a) return { text: b, at: 0 };
  if (!b) return { text: a, at: a.length };
  const hy = a.match(/([A-Za-zÀ-ɏ]+)\s?[-­]$/);
  if (hy) {
    const left = hy[1];
    const startsLower = /^[a-zß-ÿ]/.test(b);
    if (startsLower) {
      if (COMPOUND_LEFT.has(left.toLowerCase()) && !/­$/.test(a)) {
        const base = a.replace(/\s?-$/, '-');
        return { text: base + b, at: base.length };
      }
      const base = a.replace(/\s?[-­]$/, '');
      return { text: base + b, at: base.length };
    }
    if (/­$/.test(a)) { const base = a.slice(0, -1); return { text: base + ' ' + b, at: base.length + 1 }; }
    // "1914-" + "1918" or "U.S.-" + "Based": keep the hyphen, no space
    if (/^[0-9A-Z]/.test(b) && !/\s-$/.test(a)) return { text: a + b, at: a.length };
  }
  if (/\d-$/.test(a) && /^\d/.test(b)) return { text: a + b, at: a.length };
  if (/[—–]$/.test(a) || /^[—]/.test(b)) return { text: a + b, at: a.length };
  return { text: a + ' ' + b, at: a.length + 1 };
}

// Split a page's lines into paragraphs. ctx: { bodySize, lineGap }
export function pageParagraphs(lines, ctx) {
  const body = ctx.bodySize || dominantSize([lines]);
  const isHeading = (l) => (l.size > body * 1.18 && l.text.length < 140) || (HEADING_WORD.test(l.text) && l.text.length < 60 && !/[.,;]\s+\S+\s+\S+/.test(l.text) && !/[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}/.test(l.text));
  // Merge drop caps (one big letter) into the following line.
  const ls = [];
  let dropBase = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^[A-Z“‘"']?[A-Z]$/.test(l.text) && l.size > body * 1.6 && lines[i + 1]) {
      // A drop cap: the big first letter is drawn apart from the rest of its word.
      const below = lines.slice(i + 1, i + 4).filter((n) => n.y >= l.y - 1 && Math.abs(n.size - body) <= body * 0.2);
      const n = below.length ? below.reduce((a, b) => (b.y > a.y ? b : a)) : lines[i + 1];
      const j = lines.indexOf(n);
      for (let k = i + 1; k < j; k++) ls.push(lines[k]);
      ls.push({ ...n, text: l.text + n.text, x: Math.min(l.x, n.x), dropCap: true });
      dropBase = l.y;
      i = j;
      continue;
    }
    ls.push(dropBase !== null && l.y >= dropBase - 1 ? { ...l, wrapped: true } : l);
    if (dropBase !== null && l.y < dropBase - 1) dropBase = null;
  }
  const bodyLines = ls.filter((l) => Math.abs(l.size - body) <= body * 0.12);
  const gaps = [];
  for (let i = 1; i < ls.length; i++) {
    const g = ls[i - 1].y - ls[i].y;
    if (Math.abs(ls[i].size - body) <= body * 0.12 && Math.abs(ls[i - 1].size - body) <= body * 0.12 && g > 0 && g < body * 3) gaps.push(g);
  }
  const lineGap = median(gaps) || ctx.lineGap || body * 1.25;
  const leftX = bodyLines.length ? mode(bodyLines.map((l) => l.x), 1.5) : (ls.length ? Math.min(...ls.map((l) => l.x)) : 0);
  const rights = bodyLines.map((l) => l.right).sort((a, b) => a - b);
  const rightX = rights.length ? rights[Math.floor(rights.length * 0.85)] : 0;
  const paras = [];
  let cur = null;
  let prev = null;
  for (const l of ls) {
    const heading = isHeading(l);
    let start = !cur;
    if (!start) {
      const gap = prev.y - l.y;
      const indent = l.x - leftX;
      if (heading || cur.heading || l.paraStart) start = true;
      else if (gap < -body * 0.5 || gap > lineGap * 1.5 + 0.5) start = true;
      else if (indent > body * 0.6 && indent < body * 8 && bodyLines.length > 3 && !l.dropCap && !l.wrapped) start = true;
      else if (TERMINAL.test(prev.text) && rightX && prev.right < rightX - body * 3 && Math.abs(prev.size - body) <= body * 0.12) start = true;
    }
    if (start) {
      cur = { text: l.text, heading, indented: l.x - leftX > body * 0.6 && l.x - leftX < body * 8, firstLower: /^[a-z]/.test(l.text) };
      paras.push(cur);
    } else {
      cur.text = joinText(cur.text, l.text).text;
    }
    prev = l;
  }
  for (const p of paras) p.text = p.text.replace(/\s{2,}/g, ' ').trim();
  return { paras: paras.filter((p) => p.text), lineGap, body };
}

// Does the first paragraph of page `cur` continue the last paragraph of page `prev`?
export function continues(prev, cur) {
  if (!prev || !cur || !prev.paras.length || !cur.paras.length) return false;
  const a = prev.paras[prev.paras.length - 1];
  const b = cur.paras[0];
  if (a.heading || b.heading) return false;
  if (OPEN_END.test(a.text)) return true;
  if (!TERMINAL.test(a.text)) return !b.indented || b.firstLower;
  return b.firstLower && !b.indented;
}

// ---------- sentences ----------

const ABBR_TITLE = new Set(['mr', 'mrs', 'ms', 'messrs', 'mme', 'mlle', 'dr', 'drs', 'prof', 'sr', 'jr', 'st', 'mt', 'ft', 'rev', 'hon', 'gen', 'col', 'capt', 'cpt', 'lt', 'sgt', 'maj', 'cmdr', 'adm', 'gov', 'sen', 'rep', 'pres', 'supt', 'insp', 'det', 'fr', 'bros', 'vs', 'v', 'cf', 'viz', 'al', 'approx', 'dept', 'est', 'fig', 'figs', 'no', 'nos', 'vol', 'vols', 'ch', 'chap', 'p', 'pp', 'ed', 'eds', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'ave', 'blvd', 'rd', 'esq', 'op', 'ibid', 'mssrs', 'lieut', 'ca', 'c']);
const ABBR_CAN_END = new Set(['etc', 'inc', 'ltd', 'co', 'corp', 'jr', 'sr', 'esq']);
const STARTERS = new Set(['the', 'a', 'an', 'he', 'she', 'it', 'i', 'we', 'they', 'you', 'this', 'that', 'these', 'those', 'there', 'then', 'but', 'and', 'so', 'yet', 'in', 'on', 'at', 'as', 'if', 'when', 'while', 'after', 'before', 'his', 'her', 'its', 'their', 'our', 'my', 'what', 'why', 'how', 'where', 'who', 'one', 'some', 'many', 'most', 'no', 'not', 'for', 'however', 'still', 'now']);

const END_RE = /[.!?…]+["'”’)\]]*(?=\s|$)/g;

function nextWord(text, from) {
  const m = /\s*["'“‘(\[]*([^\s"'“”‘’()\[\]]*)/.exec(text.slice(from, from + 60));
  return m ? m[1] : '';
}

// Returns [{start, end}] character ranges (end exclusive, trimmed).
export function splitSentences(text) {
  const out = [];
  let start = 0;
  END_RE.lastIndex = 0;
  let m;
  while ((m = END_RE.exec(text))) {
    const punct = m[0];
    const end = m.index + punct.length;
    if (end >= text.length) break;
    const nw = nextWord(text, end);
    if (!nw) continue;
    const c = nw[0];
    let boundary = true;
    if (/[a-z]/.test(c)) boundary = false;
    else if (/^\.+$/.test(punct.replace(/["'”’)\]]+$/, '')) && punct.replace(/["'”’)\]]+$/, '').length === 1) {
      // a single period: check what comes before it
      const before = text.slice(Math.max(start, m.index - 30), m.index);
      const tok = (before.match(/([^\s"'“‘(\[]+)$/) || ['', ''])[1].split(/[—–\/]/).pop();
      const low = tok.toLowerCase();
      const closeQuote = /["'”’)\]]$/.test(punct);
      if (closeQuote) boundary = true;
      else if (/^\d+$/.test(tok) && /^\d/.test(c)) boundary = false;
      else if (low === 'etc') boundary = /[A-Z]/.test(c);
      else if (ABBR_CAN_END.has(low)) boundary = /[A-Z]/.test(c) && STARTERS.has(nw.toLowerCase());
      else if (ABBR_TITLE.has(low)) boundary = false;
      else if (/^[A-Za-z]$/.test(tok)) boundary = false; // initials: J. R. R. Tolkien
      else if (/^([A-Za-z]\.)+[A-Za-z]$/.test(tok)) boundary = /[A-Z]/.test(c) && STARTERS.has(nw.toLowerCase()) && !/^(e\.g|i\.e)$/i.test(tok);
    }
    if (boundary) {
      pushRange(out, text, start, end);
      start = end;
    }
  }
  pushRange(out, text, start, text.length);
  return chunkLong(out, text);
}

function pushRange(out, text, s, e) {
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  if (e > s) out.push({ start: s, end: e });
}

const MAX_LEN = 260;

// Very long sentences are spoken in clause-sized pieces (avoids engine cut-offs, easier to follow).
function chunkLong(ranges, text) {
  const out = [];
  for (const r of ranges) {
    let s = r.start;
    while (r.end - s > MAX_LEN) {
      const seg = text.slice(s, s + MAX_LEN);
      let cut = -1;
      for (const re of [/[;:]\s/g, /\s[—–-]\s|—/g, /,\s/g, /\s/g]) {
        let mm, best = -1;
        re.lastIndex = 0;
        while ((mm = re.exec(seg))) if (mm.index > 70) best = mm.index + mm[0].length;
        if (best > 0) { cut = best; break; }
      }
      if (cut < 0) cut = MAX_LEN;
      pushRange(out, text, s, s + cut);
      s += cut;
    }
    pushRange(out, text, s, r.end);
  }
  return out;
}

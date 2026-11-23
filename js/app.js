import { Book } from './book.js';
import * as store from './store.js';
import { Player, englishVoices, watchVoices, isQualityVoice } from './tts.js';

const $ = (s) => document.querySelector(s);
const textEl = $('#text');
const PREFS_KEY = 'reader.prefs';
const prefs = Object.assign({ rate: 1, voiceURI: '', voiceName: '', theme: 'night', fontSize: 21 }, safeJSON(localStorage.getItem(PREFS_KEY)));

let book = null;
let meta = null;
let outline = [];
let lo = 1;
let hi = 0;
let epoch = 0;
let curId = null;
let autoFollow = true;
let lastProgrammaticScroll = 0;
const sentEls = new Map();
let renderQ = Promise.resolve();
const HL = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
const wordHL = HL ? new Highlight() : null;
if (HL) CSS.highlights.set('word', wordHL);
let wordMark = null;

function safeJSON(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
function savePrefs() { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }

// ---------- player ----------
const player = new Player({
  sentence: (id) => (book ? book.sentenceSync(id) : null),
  loadSentence: (id) => book.sentence(id),
  next: (id, dir) => book.nextId(id, dir),
  onSentence: (id) => setCurrent(id),
  onWord: (id, s, e) => highlightWord(id, s, e),
  onState: (st) => onPlayState(st),
});
player.rate = prefs.rate;

// ---------- screens ----------
function show(screen) {
  $('#library').hidden = screen !== 'library';
  $('#reader').hidden = screen !== 'reader';
  document.body.dataset.screen = screen;
}

async function renderLibrary() {
  const books = await store.listBooks().catch(() => []);
  const ul = $('#books');
  ul.textContent = '';
  $('#shelf').hidden = !books.length;
  $('#emptyNote').hidden = !!books.length;
  for (const b of books) {
    const li = document.createElement('li');
    li.className = 'book';
    const page = b.pos ? b.pos.page : 1;
    const pct = b.numPages ? Math.round(((page - 1) / b.numPages) * 100) : 0;
    li.innerHTML = `
      <button class="book-open" type="button">
        <span class="spine" aria-hidden="true"></span>
        <span class="book-main">
          <span class="book-title" dir="auto"></span>
          <span class="book-author" dir="auto"></span>
          <span class="book-where"></span>
          <span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, pct)}%"></span></span>
        </span>
      </button>
      <button class="book-del" type="button" aria-label="מחיקת הספר">${ICONS.trash}</button>`;
    li.querySelector('.book-title').textContent = b.title;
    li.querySelector('.book-author').textContent = b.author || '';
    li.querySelector('.book-where').textContent = b.pos
      ? `להמשיך מעמ׳ ${page} מתוך ${b.numPages} · ${ago(b.lastOpened)}`
      : `${b.numPages} עמודים · עוד לא התחלת`;
    li.querySelector('.book-open').addEventListener('click', () => openStored(b.id));
    li.querySelector('.book-del').addEventListener('click', async () => {
      if (!confirm(`למחוק את "${b.title}" מהספרייה?`)) return;
      await store.deleteBook(b.id);
      renderLibrary();
    });
    ul.append(li);
  }
}

function ago(t) {
  if (!t) return '';
  const d = Math.floor((Date.now() - t) / 86400000);
  if (d <= 0) return 'היום';
  if (d === 1) return 'אתמול';
  if (d < 7) return `לפני ${d} ימים`;
  return new Date(t).toLocaleDateString('he-IL');
}

// ---------- opening ----------
async function openFile(file) {
  if (!file) return;
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { toast('זה לא קובץ PDF'); return; }
  busy('פותח את הספר…');
  try {
    const buf = await file.arrayBuffer();
    const blob = new Blob([buf], { type: 'application/pdf' });
    const b = await Book.open(new Uint8Array(buf.slice(0)));
    const existing = await store.getBook(b.id).catch(() => null);
    const m = existing || {
      id: b.id,
      title: b.metaTitle || file.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim() || 'ספר',
      author: b.author,
      numPages: b.numPages,
      pos: null,
      addedAt: Date.now(),
      fileName: file.name,
      size: file.size,
    };
    m.lastOpened = Date.now();
    await store.putBook(m);
    if (!existing) await store.putFile(b.id, blob);
    store.askPersist();
    await enterReader(b, m);
  } catch (e) {
    console.error(e);
    unbusy();
    toast(e && e.name === 'PasswordException' ? 'הקובץ נעול בסיסמה, אי אפשר לפתוח אותו כאן' : 'לא הצלחתי לפתוח את הקובץ הזה');
  }
}

async function openStored(id) {
  busy('פותח את הספר…');
  try {
    const m = await store.getBook(id);
    const data = await store.getFile(id);
    if (!m || !data) throw new Error('missing');
    const buf = data instanceof Blob ? await data.arrayBuffer() : data;
    const b = await Book.open(new Uint8Array(buf));
    m.lastOpened = Date.now();
    await store.putBook(m);
    await enterReader(b, m);
  } catch (e) {
    console.error(e);
    unbusy();
    toast('לא הצלחתי לפתוח את הספר הזה');
  }
}

async function enterReader(b, m) {
  if (book) { player.stop(); book.destroy(); }
  book = b;
  meta = m;
  curId = null;
  autoFollow = true;
  $('#bookTitle').textContent = m.title;
  $('#notice').hidden = true;
  show('reader');
  if (history.state !== 'reader') history.pushState('reader', '', '#read');
  book.outline().then((o) => { outline = o; }).catch(() => { outline = []; });
  if (book.scanned) {
    showNotice('הקובץ הזה הוא צילום של עמודים (סריקה), ואין בו טקסט שאפשר להקריא.', true);
  } else if (!player.supported) {
    showNotice('הדפדפן הזה לא יודע להקריא. כדאי לפתוח בספארי באייפון או באדג׳ במחשב.');
  }
  const start = m.pos && m.pos.page ? m.pos.page : 1;
  let id = m.pos ? `${m.pos.page}:${m.pos.idx}` : null;
  await jumpTo(start, id && (await book.sentence(id)) ? id : null);
  unbusy();
  if (!curId && !book.scanned) {
    const first = await book.firstIdFrom(start);
    if (first) { await ensureRendered(first); markCurrent(first, false); }
  }
}

function closeReader() {
  player.stop();
  releaseWake();
  savePosition(true);
  show('library');
  renderLibrary();
}

// ---------- rendering ----------
function queue(fn) {
  const run = renderQ.then(fn, fn);
  renderQ = run.catch(() => {});
  return run;
}

function pageDivider(p, note) {
  const d = document.createElement('div');
  d.className = 'pg';
  d.dataset.page = p;
  d.innerHTML = `<span class="pg-num">p. ${p}</span>`;
  if (note) {
    const n = document.createElement('span');
    n.className = 'pg-note';
    n.dir = 'rtl';
    n.lang = 'he';
    n.textContent = note;
    d.append(n);
  }
  return d;
}

function inlineMark(p) {
  const s = document.createElement('span');
  s.className = 'pm';
  s.dataset.page = p;
  s.textContent = `p. ${p}`;
  return s;
}

function sentenceEl(s) {
  const span = document.createElement('span');
  span.className = 's';
  span.dataset.id = s.id;
  let pos = 0;
  for (const mk of s.marks) {
    if (mk.off > pos) span.append(document.createTextNode(s.text.slice(pos, mk.off)));
    span.append(inlineMark(mk.page));
    pos = mk.off;
  }
  span.append(document.createTextNode(s.text.slice(pos)));
  sentEls.set(s.id, span);
  return span;
}

// Build the DOM nodes for one page. Returns { nodes, topOnly } where nodes is a list of block elements.
function buildPage(p, ss, atWindowStart) {
  const nodes = [];
  if (!ss.length) {
    nodes.push(pageDivider(p, book.infoCache.has(p) ? 'עמוד בלי טקסט' : ''));
    return nodes;
  }
  let para = null;
  if (ss[0].pageStart && ss[0].paraStart) nodes.push(pageDivider(p));
  else if (!ss[0].pageStart && atWindowStart) { const d = pageDivider(p); d.classList.add('top-only'); nodes.push(d); }
  ss.forEach((s, i) => {
    if (s.paraStart || !para) {
      para = document.createElement('p');
      if (s.heading) para.className = 'hd';
      if (!s.paraStart) para.classList.add('cont');
      nodes.push(para);
    } else {
      para.append(document.createTextNode(' '));
    }
    if (i === 0 && s.pageStart && !s.paraStart) para.append(inlineMark(p), document.createTextNode(' '));
    para.append(sentenceEl(s));
  });
  return nodes;
}

async function appendPage(ep) {
  const p = hi + 1;
  if (!book || p > book.numPages) return false;
  const ss = await book.sentences(p);
  if (ep !== epoch) return false;
  const nodes = buildPage(p, ss, false);
  const last = textEl.lastElementChild;
  if (nodes[0] && nodes[0].classList.contains('cont') && last && last.tagName === 'P' && !last.classList.contains('hd')) {
    const first = nodes.shift();
    last.append(document.createTextNode(' '), ...first.childNodes);
  }
  textEl.append(...nodes);
  hi = p;
  return true;
}

async function prependPage(ep) {
  const p = lo - 1;
  if (!book || p < 1) return false;
  const ss = await book.sentences(p);
  if (ep !== epoch) return false;
  const anchor = firstVisible();
  const before = anchor ? anchor.getBoundingClientRect().top : 0;
  const nodes = buildPage(p, ss, true);
  // The old first page may have had a stand-in divider; the real mark now sits inside page p's last sentence.
  const top = textEl.querySelector(`.pg.top-only[data-page="${lo}"]`);
  if (top && ss.length && ss[ss.length - 1].marks.some((mk) => mk.page === lo)) top.remove();
  const firstEl = textEl.firstElementChild;
  const lastNew = nodes[nodes.length - 1];
  if (firstEl && firstEl.tagName === 'P' && firstEl.classList.contains('cont') && lastNew && lastNew.tagName === 'P' && !lastNew.classList.contains('hd')) {
    lastNew.append(document.createTextNode(' '), ...firstEl.childNodes);
    firstEl.remove();
  }
  textEl.prepend(...nodes);
  lo = p;
  if (anchor) {
    const after = anchor.getBoundingClientRect().top;
    if (after !== before) { lastProgrammaticScroll = Date.now(); window.scrollBy(0, after - before); }
  }
  return true;
}

function firstVisible() {
  const top = 70;
  for (const el of textEl.querySelectorAll('.s, .pg')) {
    const r = el.getBoundingClientRect();
    if (r.bottom > top) return el;
  }
  return null;
}

// Clear the view and show the book from page `page` (optionally marking sentence id).
function jumpTo(page, id) {
  return queue(async () => {
    const ep = ++epoch;
    textEl.textContent = '';
    sentEls.clear();
    lo = page;
    hi = page - 1;
    await appendPage(ep);
    while (ep === epoch && hi < book.numPages && (textEl.scrollHeight < innerHeight * 2.2 || hi < page + 1)) {
      await appendPage(ep);
    }
    if (ep !== epoch) return;
    if (id && sentEls.has(id)) markCurrent(id, false);
    else {
      const d = textEl.querySelector(`[data-page="${page}"]`) || textEl.firstElementChild;
      if (d) scrollToEl(d, false, 0.12);
      else window.scrollTo(0, 0);
    }
    // Some context above, without moving what he sees.
    if (lo > 1) await prependPage(ep);
    updatePageInfo();
  });
}

function ensureRendered(id) {
  const p = Number(id.split(':')[0]);
  if (sentEls.has(id)) return Promise.resolve();
  if (p >= lo && p <= hi) return Promise.resolve();
  if (p > hi && p - hi <= 3) {
    return queue(async () => { const ep = epoch; while (hi < p && ep === epoch) { if (!(await appendPage(ep))) break; } });
  }
  if (p < lo && lo - p <= 2) {
    return queue(async () => { const ep = epoch; while (lo > p && ep === epoch) { if (!(await prependPage(ep))) break; } });
  }
  return jumpTo(p, null);
}

let fillBusy = false;
async function fillAround() {
  if (fillBusy || !book || $('#reader').hidden) return;
  fillBusy = true;
  try {
    const ep = epoch;
    const docH = document.documentElement.scrollHeight;
    if (scrollY + innerHeight > docH - innerHeight * 1.6 && hi < book.numPages) await queue(() => appendPage(ep));
    else if (scrollY < innerHeight * 1.0 && lo > 1) await queue(() => prependPage(ep));
    else return;
  } finally {
    fillBusy = false;
  }
  requestAnimationFrame(fillAround);
}

// ---------- current sentence and highlight ----------
let setToken = 0;
async function setCurrent(id) {
  const tok = ++setToken;
  if (!sentEls.has(id)) await ensureRendered(id);
  if (tok !== setToken) return;
  markCurrent(id, true);
}

function markCurrent(id, follow) {
  const prev = curId && sentEls.get(curId);
  if (prev) prev.classList.remove('cur');
  clearWord();
  curId = id;
  const el = sentEls.get(id);
  if (el) {
    el.classList.add('cur');
    if (autoFollow) scrollToEl(el, follow, 0.3);
  }
  updatePageInfo();
  savePosition(false);
  const p = Number(id.split(':')[0]);
  if (hi < p + 2 && hi < book.numPages) queue(() => appendPage(epoch));
}

function clearWord() {
  if (HL) wordHL.clear();
  if (wordMark) {
    const parent = wordMark.parentNode;
    if (parent) { wordMark.replaceWith(...wordMark.childNodes); parent.normalize(); }
    wordMark = null;
  }
}

function rangeFor(span, start, end) {
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && n.parentElement.closest('.pm') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let pos = 0;
  let n;
  const r = document.createRange();
  let started = false;
  while ((n = walker.nextNode())) {
    const len = n.data.length;
    if (!started && start < pos + len) { r.setStart(n, start - pos); started = true; }
    if (started && end <= pos + len) { r.setEnd(n, end - pos); return r; }
    pos += len;
  }
  return null;
}

function highlightWord(id, start, end) {
  if (id !== curId) return;
  const span = sentEls.get(id);
  if (!span) return;
  clearWord();
  const r = rangeFor(span, start, end);
  if (!r) return;
  if (HL) { wordHL.add(r); return; }
  try {
    const m = document.createElement('mark');
    m.className = 'w';
    r.surroundContents(m);
    wordMark = m;
  } catch { /* word crosses an element, skip */ }
}

function scrollToEl(el, smooth, frac) {
  const r = el.getBoundingClientRect();
  const vh = innerHeight;
  const topBar = 64;
  const bottomBar = 120;
  if (smooth && r.top >= topBar + 10 && r.top <= vh * 0.48 && r.bottom <= vh - bottomBar) return;
  lastProgrammaticScroll = Date.now();
  window.scrollTo({ top: Math.max(0, scrollY + r.top - Math.max(topBar + 16, vh * frac)), behavior: smooth ? 'smooth' : 'auto' });
}

function updatePageInfo() {
  if (!book) return;
  let p = curId ? Number(curId.split(':')[0]) : lo;
  if (!autoFollow || !curId) {
    const fv = firstVisible();
    if (fv) p = Number(fv.dataset.page || (fv.dataset.id || '').split(':')[0]) || p;
  }
  $('#pageInfo').textContent = `עמ׳ ${p} מתוך ${book.numPages}`;
}

let saveTimer = null;
function savePosition(now) {
  if (!meta || !curId) return;
  const [page, idx] = curId.split(':').map(Number);
  meta.pos = { page, idx };
  meta.lastOpened = Date.now();
  clearTimeout(saveTimer);
  const doSave = () => store.putBook(meta).catch(() => {});
  if (now) doSave(); else saveTimer = setTimeout(doSave, 700);
}

// ---------- follow mode ----------
function userScrolled() {
  if (!curId || $('#reader').hidden) return;
  if (autoFollow) {
    autoFollow = false;
    $('#follow').hidden = false;
  }
}

function backToReading() {
  autoFollow = true;
  $('#follow').hidden = true;
  if (curId) {
    const el = sentEls.get(curId);
    if (el) scrollToEl(el, true, 0.3);
    else ensureRendered(curId).then(() => { const e2 = sentEls.get(curId); if (e2) { e2.classList.add('cur'); scrollToEl(e2, false, 0.3); } });
  }
}

// ---------- play state, wake lock ----------
function onPlayState(st) {
  const playing = st === 'playing';
  document.body.classList.toggle('playing', playing);
  $('#play').innerHTML = playing ? ICONS.pause : ICONS.play;
  $('#play').setAttribute('aria-label', playing ? 'השהיה' : 'הקראה');
  if (playing) requestWake(); else releaseWake();
  if (!playing) clearWord();
  if (st === 'ended') toast('הגעת לסוף הספר');
  if (st === 'blocked') toast('הדפדפן חסם את ההקראה. צריך ללחוץ על כפתור ההקראה');
  savePosition(true);
}

let wakeLock = null;
async function requestWake() {
  try {
    if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { wakeLock = null; }
}
function releaseWake() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && player.playing) requestWake();
  if (document.visibilityState === 'hidden') savePosition(true);
});
addEventListener('pagehide', () => savePosition(true));

// ---------- actions ----------
function firstVisibleSentenceId() {
  for (const el of textEl.querySelectorAll('.s')) {
    const r = el.getBoundingClientRect();
    if (r.bottom > 70) return el.dataset.id;
  }
  return null;
}

function playPause() {
  if (!book || book.scanned) return;
  if (player.playing) { player.pause(); return; }
  const id = curId || firstVisibleSentenceId();
  if (!id) return;
  autoFollow = true;
  $('#follow').hidden = true;
  player.play(id);
}

function playFrom(id) {
  autoFollow = true;
  $('#follow').hidden = true;
  player.play(id);
}

async function step(dir, count) {
  if (!book) return;
  if (!player.playing && curId) player.cur = curId;
  if (!player.cur) { const f = firstVisibleSentenceId(); if (!f) return; player.cur = f; }
  autoFollow = true;
  $('#follow').hidden = true;
  await player.jump(dir, count);
}

async function goToPage(n) {
  if (!book) return;
  const p = Math.min(book.numPages, Math.max(1, Math.round(n)));
  closeSheet();
  autoFollow = true;
  $('#follow').hidden = true;
  const wasPlaying = player.playing;
  if (wasPlaying) player.pause();
  await jumpTo(p, null);
  const id = await book.firstIdFrom(p);
  if (!id) return;
  await ensureRendered(id);
  markCurrent(id, false);
  scrollToEl(sentEls.get(id), false, 0.3);
  if (wasPlaying) player.play(id);
}

// ---------- sheets ----------
function openSheet(title, body) {
  $('#sheetTitle').textContent = title;
  const b = $('#sheetBody');
  b.textContent = '';
  b.append(body);
  $('#sheet').hidden = false;
  requestAnimationFrame(() => $('#sheet').classList.add('open'));
}
function closeSheet() {
  const s = $('#sheet');
  s.classList.remove('open');
  setTimeout(() => { if (!s.classList.contains('open')) s.hidden = true; }, 220);
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function menuSheet() {
  const p = curId ? Number(curId.split(':')[0]) : lo;
  const box = el(`<div class="menu">
    <form class="row goto" autocomplete="off">
      <label for="gotoInput">מעבר לעמוד</label>
      <div class="goto-in"><input id="gotoInput" type="number" inputmode="numeric" min="1" max="${book.numPages}" value="${p}"><span class="of">מתוך ${book.numPages}</span><button class="btn accent" type="submit">מעבר</button></div>
    </form>
    <button class="row link" id="chaptersRow" type="button" ${outline.length ? '' : 'hidden'}>${ICONS.list}<span>פרקים</span><span class="sub">${outline.length}</span></button>
    <button class="row link" id="voiceRow" type="button">${ICONS.voice}<span>קול הקריין</span><span class="sub" dir="ltr">${player.voice ? player.voice.name : ''}</span></button>
    <div class="row">
      <span class="lbl">תצוגה</span>
      <div class="seg" role="group" aria-label="ערכת צבעים">
        <button type="button" data-theme="night">לילה</button><button type="button" data-theme="sepia">ספיה</button><button type="button" data-theme="day">יום</button>
      </div>
    </div>
    <div class="row">
      <span class="lbl">גודל אות</span>
      <div class="seg size"><button type="button" data-fs="-1" aria-label="קטן יותר">א-</button><span class="fs-val">${prefs.fontSize}</span><button type="button" data-fs="1" aria-label="גדול יותר">א+</button></div>
    </div>
  </div>`);
  box.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); const v = Number(box.querySelector('input').value); if (v) goToPage(v); });
  box.querySelector('#chaptersRow').addEventListener('click', chaptersSheet);
  box.querySelector('#voiceRow').addEventListener('click', voiceSheet);
  box.querySelectorAll('[data-theme]').forEach((b) => {
    b.classList.toggle('on', b.dataset.theme === prefs.theme);
    b.addEventListener('click', () => { setTheme(b.dataset.theme); box.querySelectorAll('[data-theme]').forEach((x) => x.classList.toggle('on', x === b)); });
  });
  box.querySelectorAll('[data-fs]').forEach((b) => b.addEventListener('click', () => {
    setFontSize(prefs.fontSize + Number(b.dataset.fs) * 2);
    box.querySelector('.fs-val').textContent = prefs.fontSize;
  }));
  openSheet('הספר', box);
}

function chaptersSheet() {
  const list = el('<ul class="chapters"></ul>');
  const p = curId ? Number(curId.split(':')[0]) : lo;
  let currentIdx = -1;
  outline.forEach((o, i) => { if (o.page <= p) currentIdx = i; });
  outline.forEach((o, i) => {
    const li = el(`<li><button type="button" class="chap d${o.depth}${i === currentIdx ? ' here' : ''}"><span class="ct" dir="auto"></span><span class="cp">עמ׳ ${o.page}</span></button></li>`);
    li.querySelector('.ct').textContent = o.title;
    li.querySelector('button').addEventListener('click', () => goToPage(o.page));
    list.append(li);
  });
  openSheet('פרקים', list);
  const here = list.querySelector('.here');
  if (here) here.scrollIntoView({ block: 'center' });
}

function voiceSheet() {
  const voices = englishVoices();
  const box = el('<div class="voices"></div>');
  if (!voices.length) {
    box.append(el('<p class="empty">עוד לא נמצאו קולות באנגלית במכשיר הזה. אם זה לא משתנה בעוד כמה שניות, צריך להוריד קול באנגלית בהגדרות של המכשיר.</p>'));
  }
  const good = voices.filter(isQualityVoice);
  const rest = voices.filter((v) => !isQualityVoice(v));
  const group = (title, list) => {
    if (!list.length) return;
    box.append(el(`<h4>${title}</h4>`));
    for (const v of list) {
      const on = player.voice && player.voice.voiceURI === v.voiceURI && player.voice.name === v.name;
      const b = el(`<button type="button" class="voice${on ? ' on' : ''}"><span class="vn" dir="ltr"></span><span class="vl" dir="ltr"></span><span class="check">${ICONS.check}</span></button>`);
      b.querySelector('.vn').textContent = v.name.replace(/^Microsoft\s+/, '');
      b.querySelector('.vl').textContent = v.lang;
      b.addEventListener('click', () => {
        chooseVoice(v);
        box.querySelectorAll('.voice').forEach((x) => x.classList.toggle('on', x === b));
        if (!player.playing) preview(v);
      });
      box.append(b);
    }
  };
  group('הכי טבעיים', good);
  group(good.length ? 'עוד קולות' : 'קולות באנגלית', rest);
  box.append(el('<p class="tip">רוצה קול טבעי יותר? באייפון מורידים פעם אחת בחינם: הגדרות, נגישות, קריאה ודיבור, קולות, אנגלית, ובוחרים קול משופר (Enhanced או Premium), למשל Ava או Zoe. אחרי ההורדה צריך לסגור ולפתוח את האפליקציה. במחשב הקולות הכי טובים נמצאים בדפדפן Edge.</p>'));
  openSheet('קול הקריין', box);
}

function preview(v) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance('This is how I will read your book.');
    u.voice = v; u.lang = v.lang; u.rate = player.rate;
    speechSynthesis.speak(u);
  } catch { /* ignore */ }
}

function speedSheet() {
  const box = el(`<div class="speed">
    <div class="speed-big"><button type="button" class="round" data-d="-0.1" aria-label="לאט יותר">−</button><output dir="ltr" class="speed-val"></output><button type="button" class="round" data-d="0.1" aria-label="מהר יותר">+</button></div>
    <input type="range" min="0.75" max="2.5" step="0.05" dir="ltr" aria-label="מהירות">
    <div class="presets" dir="ltr">${[0.9, 1, 1.2, 1.4, 1.6, 2].map((r) => `<button type="button" data-r="${r}">${r.toFixed(1)}×</button>`).join('')}</div>
  </div>`);
  const out = box.querySelector('.speed-val');
  const range = box.querySelector('input');
  const sync = () => { out.textContent = prefs.rate.toFixed(2).replace(/0$/, '') + '×'; range.value = prefs.rate; box.querySelectorAll('[data-r]').forEach((b) => b.classList.toggle('on', Number(b.dataset.r) === prefs.rate)); };
  box.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => { setRate(prefs.rate + Number(b.dataset.d)); sync(); }));
  box.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => { setRate(Number(b.dataset.r)); sync(); }));
  range.addEventListener('input', () => { setRate(Number(range.value), true); sync(); });
  range.addEventListener('change', () => { setRate(Number(range.value)); sync(); });
  sync();
  openSheet('מהירות הקראה', box);
}

let rateTimer = null;
function setRate(r, defer) {
  r = Math.round(Math.min(2.5, Math.max(0.75, r)) * 20) / 20;
  prefs.rate = r;
  savePrefs();
  $('#speedBtn').textContent = r.toFixed(2).replace(/0$/, '') + '×';
  clearTimeout(rateTimer);
  if (defer) rateTimer = setTimeout(() => player.setRate(r), 350);
  else player.setRate(r);
}

function chooseVoice(v) {
  prefs.voiceURI = v.voiceURI;
  prefs.voiceName = v.name;
  savePrefs();
  player.setVoice(v);
  updateVoiceChip();
}

function updateVoiceChip() {
  const v = player.voice;
  $('#voiceName').textContent = v ? v.name.replace(/^Microsoft\s+/, '').replace(/\s+-\s+English.*$/, '') : 'קול';
}

function pickVoice() {
  const voices = englishVoices();
  if (!voices.length) return;
  const saved = voices.find((v) => v.voiceURI === prefs.voiceURI && v.name === prefs.voiceName) || voices.find((v) => v.name === prefs.voiceName);
  const v = saved || voices[0];
  if (!player.voice || player.voice.name !== v.name) player.voice = v;
  updateVoiceChip();
}

function setTheme(t) {
  prefs.theme = t;
  savePrefs();
  document.body.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#14120f';
}

function setFontSize(fs) {
  const anchor = curId && sentEls.get(curId);
  prefs.fontSize = Math.min(34, Math.max(15, fs));
  savePrefs();
  document.documentElement.style.setProperty('--fs', prefs.fontSize + 'px');
  if (anchor) scrollToEl(anchor, false, 0.3);
}

// ---------- notices ----------
function showNotice(msg, scanned) {
  const n = $('#notice');
  n.textContent = '';
  n.append(el(`<p></p>`));
  n.firstChild.textContent = msg;
  if (scanned) {
    const b = el('<button type="button" id="ocrBtn" class="btn accent">לזהות את הטקסט מהתמונות</button>');
    b.addEventListener('click', startOcr);
    n.append(b);
  }
  n.hidden = false;
}

async function startOcr() {
  const b = book;
  const { ocrPage } = await import('./ocr.js');
  if (b !== book) return;
  b.onOcr = (p, st) => {
    if (b !== book) return;
    $('#notice').firstChild.textContent = st === 'start'
      ? `מזהה את הטקסט בעמוד ${p}… בכל עמוד זה לוקח כמה שניות, והספר ממשיך להיטען בזמן ההקראה.`
      : 'הזיהוי רץ עמוד אחרי עמוד. אפשר להתחיל להקשיב.';
  };
  b.enableOcr(ocrPage);
  const btn = $('#ocrBtn');
  if (btn) btn.remove();
  $('#notice').firstChild.textContent = 'טוען את מנוע הזיהוי…';
  const start = meta && meta.pos ? meta.pos.page : 1;
  await jumpTo(start, null);
  if (b !== book) return;
  const first = await b.firstIdFrom(start);
  if (first && !curId) { await ensureRendered(first); markCurrent(first, false); }
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.hidden = true; }, 300); }, 3200);
}

function busy(msg) { $('#busyMsg').textContent = msg; $('#busy').hidden = false; }
function unbusy() { $('#busy').hidden = true; }

// ---------- icons ----------
const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  voice: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// ---------- wiring ----------
function init() {
  document.body.dataset.theme = prefs.theme;
  document.documentElement.style.setProperty('--fs', prefs.fontSize + 'px');
  setTheme(prefs.theme);
  $('#speedBtn').textContent = prefs.rate.toFixed(2).replace(/0$/, '') + '×';
  $('#play').innerHTML = ICONS.play;

  const fileInput = $('#file');
  $('#openBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { const f = fileInput.files && fileInput.files[0]; fileInput.value = ''; openFile(f); });

  addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
  addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) openFile(f);
  });

  $('#backBtn').addEventListener('click', () => { if (history.state === 'reader') history.back(); else closeReader(); });
  addEventListener('popstate', () => { if (!$('#reader').hidden) closeReader(); });
  $('#menuBtn').addEventListener('click', menuSheet);
  $('#pageInfo').addEventListener('click', menuSheet);
  $('#play').addEventListener('click', playPause);
  $('#prev').addEventListener('click', () => step(-1, 1));
  $('#next').addEventListener('click', () => step(1, 1));
  $('#back10').addEventListener('click', () => step(-1, 10));
  $('#speedBtn').addEventListener('click', speedSheet);
  $('#voiceBtn').addEventListener('click', voiceSheet);
  $('#follow').addEventListener('click', backToReading);
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet' || e.target.closest('.sheet-close')) closeSheet(); });

  textEl.addEventListener('click', (e) => {
    if (getSelection && String(getSelection()).length > 1) return;
    const s = e.target.closest('.s');
    if (!s || !book || book.scanned) return;
    playFrom(s.dataset.id);
  });

  addEventListener('wheel', userScrolled, { passive: true });
  addEventListener('touchmove', userScrolled, { passive: true });
  addEventListener('keydown', (e) => {
    if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(e.key) && !e.target.closest('input,select,textarea')) userScrolled();
  });
  let ticking = false;
  addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; fillAround(); if (!player.playing) updatePageInfo(); });
  }, { passive: true });

  addEventListener('keydown', (e) => {
    if ($('#reader').hidden || e.target.closest('input,select,textarea,button[role=none]')) return;
    if ($('#sheet').classList.contains('open')) { if (e.key === 'Escape') closeSheet(); return; }
    if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); playPause(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1, 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1, 1); }
  });

  watchVoices(pickVoice);

  const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if ('serviceWorker' in navigator && secure && !/[?&]nosw(&|$)/.test(location.search)) navigator.serviceWorker.register('sw.js').catch(() => {});

  if (location.hash === '#read') history.replaceState(null, '', location.pathname);
  show('library');
  renderLibrary();
}

init();

// For automated tests only.
window.__reader = {
  get book() { return book; },
  get curId() { return curId; },
  get range() { return [lo, hi]; },
  get playing() { return player.playing; },
  get autoFollow() { return autoFollow; },
  player,
  goToPage,
};

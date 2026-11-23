// End-to-end test with a fake speech engine. Usage: node tests/e2e.mjs <baseUrl> <outDir> <pdfDir>
import { chromium, devices } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = process.argv[2] || 'http://localhost:8765/';
const OUT = process.argv[3] || 'tests/out';
const PDFS = process.argv[4] || 'tests/pdfs';
fs.mkdirSync(OUT, { recursive: true });
const stub = fs.readFileSync(new URL('./speech-stub.js', import.meta.url), 'utf8');
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok, info: String(info).slice(0, 300) }); console.log(ok ? 'PASS' : 'FAIL', name, info ? '- ' + String(info).slice(0, 200) : ''); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'msedge' });

async function waitFor(page, fn, arg, timeout = 15000) {
  return page.waitForFunction(fn, arg, { timeout, polling: 50 });
}

async function openPdf(page, file) {
  await page.setInputFiles('#file', path.join(PDFS, file));
  await waitFor(page, () => !document.querySelector('#reader').hidden && document.querySelectorAll('#text .s').length > 0 && document.querySelector('#busy').hidden, null, 60000);
}

const spoken = (page) => page.evaluate(() => window.__ttsLog.filter((e) => e.ev === 'speak').map((e) => e.text));

// ---------------- mobile ----------------
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'], defaultBrowserType: undefined });
  await ctx.addInitScript(stub);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE + '?nosw');
  await page.waitForSelector('#openBtn');
  check('library screen shows open button', await page.isVisible('#openBtn'));

  await openPdf(page, 'test-book.pdf');
  check('test book opens', true);
  const txt = await page.evaluate(() => document.querySelector('#text').innerText);
  check('no running header in text', !/THE QUIET STATION/.test(txt));
  check('no broken hyphenation', !/[a-z]- [a-z]/.test(txt.replace(/—/g, ' ')) && /remarkable/.test(txt), (txt.match(/\w+- \w+/g) || []).join(','));
  const spans = await page.evaluate(() => [...document.querySelectorAll('#text .s')].map((s) => s.textContent.replace(/p\. \d+/g, '').replace(/\s+/g, ' ').trim()));
  check('no page-number-only lines', !spans.some((s) => /^\d+$/.test(s)));
  check('abbreviations kept in one sentence (Mr., Dr., U.S., 7.45)', spans.some((s) => s.startsWith('Dr. Avery was already waiting') && s.includes('U.S. delegation in remarkable detail.')) && spans.some((s) => s.startsWith('Mr. Holloway arrived at the station at 7.45 in the morning')));
  check('e.g. and i.e. not split', spans.some((s) => s.includes('e.g. fog and ice')) && spans.some((s) => s.includes('i.e. the unpaid debts')));
  check('quotes split sensibly', spans.includes('“You are late,” she said.') && spans.includes('“I have been here since dawn.”'));
  check('ligatures normalised', /first snow/.test(txt) && !/[ﬀ-ﬆ]/.test(txt));
  check('page markers present', (await page.locator('#text .pg, #text .pm').count()) > 2);
  check('chapter headings kept', /Chapter 1/.test(txt) && /The Arrival/.test(txt));

  // tap a sentence -> starts from it
  await page.evaluate(() => { window.__wordMs = 25; });
  const target = page.locator('#text .s').nth(6);
  const targetText = await target.evaluate((e) => e.dataset.id);
  await target.click();
  await waitFor(page, () => window.__ttsLog.some((e) => e.ev === 'speak'));
  const firstSpoken = (await spoken(page))[0];
  const targetSentence = await page.evaluate((id) => window.__reader.book.sentenceSync(id).text, targetText);
  check('tap a sentence starts reading from it', firstSpoken === targetSentence && (await page.evaluate(() => window.__reader.curId)) === targetText, firstSpoken);

  // word highlight advances inside the sentence
  const words = [];
  for (let i = 0; i < 12; i++) {
    words.push(await page.evaluate(() => {
      const h = CSS.highlights.get('word');
      if (!h || !h.size) return null;
      const r = [...h][0];
      const s = r.startContainer.parentElement.closest('.s');
      return { id: s && s.dataset.id, word: r.toString(), cur: window.__reader.curId, isCur: s && s.classList.contains('cur') };
    }));
    await sleep(9);
  }
  const ws = words.filter(Boolean);
  check('word highlight is inside the highlighted sentence', ws.length > 3 && ws.every((w) => w.id === w.cur && w.isCur && /\S/.test(w.word)), JSON.stringify(ws.slice(0, 4)));

  // let it read across page boundaries
  await waitFor(page, () => Number((window.__reader.curId || '0:0').split(':')[0]) >= 5, null, 60000);
  await page.click('#play'); // pause
  const order = await page.evaluate((startId) => {
    const all = [...document.querySelectorAll('#text .s')].map((s) => s.dataset.id);
    return all.slice(all.indexOf(startId));
  }, targetText);
  const said = await spoken(page);
  const expectTexts = await page.evaluate((ids) => ids.map((id) => window.__reader.book.sentenceSync(id).text), order.slice(0, said.length));
  const mismatch = said.findIndex((t, i) => t !== expectTexts[i]);
  check('reading order across pages: no skips or repeats', said.length > 20 && mismatch === -1, `spoken ${said.length}, first mismatch ${mismatch}: ${mismatch >= 0 ? said[mismatch] + ' / ' + expectTexts[mismatch] : ''}`);
  const crossed = new Set(order.slice(0, said.length).map((id) => id.split(':')[0]));
  check('reading crossed several pages', crossed.size >= 3, [...crossed].join(','));

  // pause / resume continues from the same sentence
  const pausedAt = await page.evaluate(() => window.__reader.curId);
  const nBefore = (await spoken(page)).length;
  await sleep(500);
  check('pause stops speech', (await spoken(page)).length === nBefore && !(await page.evaluate(() => window.__reader.playing)));
  await page.click('#play');
  await waitFor(page, (n) => window.__ttsLog.filter((e) => e.ev === 'speak').length > n, nBefore);
  const resumed = (await spoken(page))[nBefore];
  const pausedText = await page.evaluate((id) => window.__reader.book.sentenceSync(id).text, pausedAt);
  check('resume restarts the same sentence', resumed === pausedText, resumed);

  // speed
  await page.click('#speedBtn');
  await page.click('.speed [data-d="0.1"]');
  await page.click('.speed [data-d="0.1"]');
  await waitFor(page, () => { const s = window.__ttsLog.filter((e) => e.ev === 'speak'); return s.length && Math.abs(s[s.length - 1].rate - 1.2) < 0.001; });
  const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('reader.prefs')));
  check('speed change applies to speech and is remembered', Math.abs(prefs.rate - 1.2) < 0.001, prefs.rate);
  await page.click('.sheet-close');
  await sleep(300);

  // voices
  await page.click('#voiceBtn');
  const vnames = await page.$$eval('.voice .vn', (e) => e.map((x) => x.textContent));
  check('voice list: English only, natural voice first', vnames.length === 3 && /Aria Online \(Natural\)/.test(vnames[0]) && !vnames.some((n) => /Hebrew|Asaf/.test(n)), vnames.join(' | '));
  await page.locator('.voice', { hasText: 'Google UK' }).click();
  await waitFor(page, () => { const s = window.__ttsLog.filter((e) => e.ev === 'speak'); return s.length && s[s.length - 1].voice === 'Google UK English Female'; });
  check('chosen voice is used and saved', (await page.evaluate(() => JSON.parse(localStorage.getItem('reader.prefs')).voiceName)) === 'Google UK English Female');
  await page.click('.sheet-close');
  await sleep(300);

  // manual scroll stops follow mode
  await page.mouse.move(200, 400);
  await page.evaluate(() => window.dispatchEvent(new WheelEvent('wheel', { deltaY: 400 })));
  await page.evaluate(() => window.scrollBy(0, 600));
  await sleep(200);
  check('manual scroll shows "back to reading" button', (await page.isVisible('#follow')) && !(await page.evaluate(() => window.__reader.autoFollow)));
  await page.click('#follow');
  await sleep(700);
  const curVisible = await page.evaluate(() => { const e = document.querySelector('.s.cur'); if (!e) return false; const r = e.getBoundingClientRect(); return r.top > 50 && r.top < innerHeight * 0.6; });
  check('back-to-reading returns to the current sentence', curVisible && (await page.evaluate(() => window.__reader.autoFollow)));

  // screenshot while playing (slow words so the word highlight is visible)
  await page.evaluate(() => { window.__wordMs = 900; });
  await page.click('#play'); // pause
  await page.click('#play'); // resume
  await sleep(2100);
  await page.screenshot({ path: path.join(OUT, 'mobile-reading.png') });
  const hasWord = await page.evaluate(() => CSS.highlights.get('word').size === 1);
  check('screenshot taken with sentence and word highlight', hasWord);
  await page.evaluate(() => { window.__wordMs = 25; });
  await page.click('#play'); // pause

  // go to page
  await page.click('#menuBtn');
  await page.fill('#gotoInput', '8');
  await page.click('.goto button[type=submit]');
  await waitFor(page, () => (window.__reader.curId || '').startsWith('8:'));
  const p8 = await page.evaluate(() => { const e = document.querySelector('.s.cur'); const r = e.getBoundingClientRect(); return r.top > 40 && r.top < innerHeight; });
  check('go to page 8 works', p8);

  // chapters
  await page.click('#menuBtn');
  await page.click('#chaptersRow');
  const chaps = await page.$$eval('.chap .ct', (e) => e.map((x) => x.textContent));
  check('chapters list from the PDF outline', chaps.length === 5 && chaps[2] === 'Chapter 3: The Library', chaps.join(' | '));
  await page.locator('.chap', { hasText: 'Chapter 3' }).click();
  await waitFor(page, () => (window.__reader.curId || '').startsWith('6:'));
  const curTxt = await page.evaluate(() => document.querySelector('.s.cur').textContent);
  check('chapter jump lands on the chapter start', /Chapter 3/.test(curTxt), curTxt);

  // keyboard: arrows
  const before = await page.evaluate(() => window.__reader.curId);
  await page.keyboard.press('ArrowRight');
  await sleep(200);
  const after = await page.evaluate(() => window.__reader.curId);
  check('arrow key moves to next sentence', before === '6:0' && after === '6:1', before + ' -> ' + after);
  await page.keyboard.press('ArrowLeft');
  await sleep(200);
  check('arrow left moves back', (await page.evaluate(() => window.__reader.curId)) === '6:0');

  // position survives reload
  await sleep(1000);
  await page.reload();
  await page.waitForSelector('.book');
  const libText = await page.locator('#books').innerText();
  check('library lists the book with resume page', /The Quiet Station/.test(libText) && /להמשיך מעמ׳ 6/.test(libText), libText);
  await page.click('.book-open');
  await waitFor(page, () => window.__reader.curId === '6:0' && document.querySelector('.s.cur'), null, 20000);
  check('reopening continues at the same sentence', true);

  // big book
  await page.click('#backBtn');
  await page.waitForSelector('#openBtn');
  const t0 = Date.now();
  await openPdf(page, 'pride.pdf');
  const firstText = Date.now() - t0;
  check('479-page PDF opens fast (time to first text)', firstText < 8000, firstText + ' ms');
  const big = await page.evaluate(() => window.__reader.book.numPages);
  check('big book page count', big === 479, big);
  // responsiveness: main thread long tasks while extracting more pages
  const lag = await page.evaluate(async () => {
    let worst = 0; let last = performance.now();
    const iv = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last - 50); last = n; }, 50);
    await window.__reader.goToPage(200);
    await new Promise((r) => setTimeout(r, 1500));
    clearInterval(iv);
    return Math.round(worst);
  });
  check('jump to page 200 without freezing (worst main-thread stall)', lag < 600, lag + ' ms');
  await window_goto(page, 11);
  const ptext = await page.evaluate(() => document.querySelector('#text').innerText);
  check('real book: hyphenation and footer removed', /disconcerted/.test(ptext) && !/Planet eBook\.com/.test(ptext), '');
  await page.screenshot({ path: path.join(OUT, 'mobile-pride.png') });
  await page.click('#backBtn');
  await page.waitForSelector('.book');
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, 'mobile-library.png') });
  check('library shows both books', (await page.locator('.book').count()) === 2);
  check('no page errors (mobile)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

async function window_goto(page, n) {
  await page.evaluate((x) => window.__reader.goToPage(x), n);
  await waitFor(page, (x) => (window.__reader.curId || '').startsWith(x + ':'), n);
}

// ---------------- desktop ----------------
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  await ctx.addInitScript(stub);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + '?nosw');
  await page.waitForSelector('#openBtn');
  await page.screenshot({ path: path.join(OUT, 'desktop-library-empty.png') });
  await openPdf(page, 'timemachine.pdf');
  await page.evaluate(() => window.__reader.goToPage(12));
  await waitFor(page, () => (window.__reader.curId || '').startsWith('12:'));
  await page.evaluate(() => { window.__wordMs = 30; });
  await page.keyboard.press('Space');
  await waitFor(page, () => window.__reader.playing);
  check('space starts playing (desktop)', true);
  await sleep(800);
  await page.keyboard.press('Space');
  check('space pauses (desktop)', !(await page.evaluate(() => window.__reader.playing)));
  await page.evaluate(() => { window.__wordMs = 900; });
  await page.keyboard.press('Space');
  await sleep(2100);
  await page.screenshot({ path: path.join(OUT, 'desktop-reading.png') });
  await page.keyboard.press('Space');
  check('no page errors (desktop)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ---------------- scanned PDF ----------------
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  await ctx.addInitScript(stub);
  const page = await ctx.newPage();
  await page.goto(BASE + '?nosw');
  await page.setInputFiles('#file', path.join(PDFS, 'scanned.pdf'));
  await waitFor(page, () => !document.querySelector('#notice').hidden, null, 30000);
  const msg = await page.locator('#notice').innerText();
  check('scanned PDF: clear Hebrew message', /סריקה/.test(msg), msg);
  await page.screenshot({ path: path.join(OUT, 'mobile-scanned.png') });
  const t0 = Date.now();
  await page.click('#ocrBtn');
  let ocrOk = true;
  try { await waitFor(page, () => /bright cold day in April/.test(document.querySelector('#text').innerText), null, 180000); } catch { ocrOk = false; }
  const ocrText = await page.evaluate(() => document.querySelector('#text').innerText.slice(0, 400));
  check('OCR turns a scanned page into readable sentences', ocrOk, `${Date.now() - t0} ms: ${ocrText.replace(/\s+/g, ' ').slice(0, 160)}`);
  if (ocrOk) {
    await page.locator('#text .s').first().click();
    await waitFor(page, () => window.__ttsLog.some((e) => e.ev === 'speak'));
    const first = await page.evaluate(() => window.__ttsLog.find((e) => e.ev === 'speak').text);
    check('OCR text can be read aloud', /April|bright/.test(first), first);
    await page.screenshot({ path: path.join(OUT, 'mobile-ocr.png') });
  }
  await ctx.close();
}

// ---------------- PWA: installable and works offline ----------------
if (!process.env.SKIP_PWA) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  await ctx.addInitScript(stub);
  const page = await ctx.newPage();
  await page.goto(BASE);
  const manifest = await page.evaluate(async () => { const l = document.querySelector('link[rel=manifest]'); const r = await fetch(l.href); return r.json(); });
  check('manifest has name, standalone display and icons', manifest.display === 'standalone' && manifest.icons.length >= 3, manifest.name);
  const robots = await page.getAttribute('meta[name=robots]', 'content');
  check('noindex meta present', /noindex/.test(robots || ''));
  await waitFor(page, () => navigator.serviceWorker && navigator.serviceWorker.controller, null, 20000).catch(() => null);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) { await page.reload(); await waitFor(page, () => !!navigator.serviceWorker.controller, null, 20000); }
  await sleep(1500);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('#openBtn', { timeout: 15000 });
  await page.setInputFiles('#file', path.join(PDFS, 'test-book.pdf'));
  let offlineOk = true;
  try { await waitFor(page, () => document.querySelectorAll('#text .s').length > 0, null, 30000); } catch { offlineOk = false; }
  check('works offline after first visit (app + PDF engine cached)', offlineOk);
  await ctx.setOffline(false);
  await ctx.close();
}

await browser.close();
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

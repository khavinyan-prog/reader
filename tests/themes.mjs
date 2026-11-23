import { chromium, devices } from 'playwright';
import fs from 'fs';
const [BASE, PDF, OUTDIR] = process.argv.slice(2);
const stub = fs.readFileSync(new URL('./speech-stub.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
await ctx.addInitScript(stub);
const page = await ctx.newPage();
await page.goto(BASE + '?nosw');
await page.setInputFiles('#file', PDF);
await page.waitForFunction(() => document.querySelectorAll('#text .s').length > 0 && document.querySelector('#busy').hidden);
await page.evaluate(() => { window.__wordMs = 1500; });
await page.locator('#text .s').nth(4).click();
await new Promise((r) => setTimeout(r, 1700));
for (const t of ['sepia', 'day']) {
  await page.click('#menuBtn');
  await page.click(`[data-theme="${t}"]`);
  await new Promise((r) => setTimeout(r, 400));
  if (t === 'sepia') await page.screenshot({ path: `${OUTDIR}/menu-${t}.png` });
  await page.click('.sheet-close');
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: `${OUTDIR}/theme-${t}.png` });
}
await page.click('#speedBtn'); await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: `${OUTDIR}/speed-sheet.png` });
await browser.close();

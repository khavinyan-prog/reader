// Renders the PNG icons from icons/icon.svg with Playwright (Edge).
import { chromium } from 'playwright';
import fs from 'fs';
const svg = fs.readFileSync('icons/icon.svg', 'utf8');
const square = svg.replace('rx="112"', 'rx="0"');
const maskable = square.replace('<g ', '<g transform="translate(256 256) scale(.78) translate(-256 -256)" ');
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage();
async function shot(src, size, out) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${src.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
await shot(svg, 192, 'icons/icon-192.png');
await shot(svg, 512, 'icons/icon-512.png');
await shot(maskable, 512, 'icons/maskable-512.png');
await shot(square, 180, 'icons/apple-touch-icon.png');
await browser.close();
console.log('ok');

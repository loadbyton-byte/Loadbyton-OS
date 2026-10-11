#!/usr/bin/env node
/** Export the already outlined SVG kit with Chromium; no application/database required. */
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/brand');
const catalogue = JSON.parse(await fs.readFile(path.join(root, 'asset-index.json'), 'utf8'));
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.pdf': 'application/pdf', '.ico': 'image/x-icon', '.zip': 'application/zip', '.md': 'text/plain' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' }); res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/chromium', headless: true, args: process.env.CHROME_NO_SANDBOX === 'true' ? ['--no-sandbox'] : [] });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const exports = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const asset of catalogue.assets) {
    if (['Sector and UI icons', 'Patterns'].includes(asset.category)) continue;
    const source = asset.editableText ? `outlined/${asset.path}` : asset.path;
    const markup = await fs.readFile(path.join(root, source), 'utf8');
    await page.setViewportSize({ width: asset.width, height: asset.height });
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}svg{display:block;width:100%;height:100%}@page{margin:0}</style></head><body>${markup}</body></html>`);
    const stem = asset.path.replace(/\.svg$/, '');
    const png = path.join(root, 'exports', `${stem}.png`);
    await fs.mkdir(path.dirname(png), { recursive: true });
    await page.screenshot({ path: png, omitBackground: true });
    exports.push({ source: asset.path, file: `exports/${stem}.png`, width: asset.width, height: asset.height });
    if (['Print templates', 'Document templates', 'Digital templates', 'Logo masters', 'Brand guide'].includes(asset.category)) {
      const width = asset.physicalMm ? `${asset.physicalMm[0]}mm` : `${asset.width}px`;
      const height = asset.physicalMm ? `${asset.physicalMm[1]}mm` : `${asset.height}px`;
      await page.pdf({ path: path.join(root, 'exports', `${stem}.pdf`), width, height, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
      exports.push({ source: asset.path, file: `exports/${stem}.pdf`, physicalMm: asset.physicalMm, colourSpace: 'RGB proof; printer ICC conversion required' });
    }
  }
  for (const [source, file, sizes] of [
    ['favicon.svg', 'favicon-', [16, 32, 48]],
    ['by-mark.svg', 'app-icon-', [192, 512]],
    ['by-mark.svg', 'by-mark-', [32, 64, 192]],
    ['by-mark.svg', 'apple-touch-icon-', [180]],
    ['app-icon-maskable.svg', 'app-icon-maskable-', [512]],
  ]) {
    for (const size of sizes) {
      await page.setViewportSize({ width: size, height: size });
      const svg = await fs.readFile(path.join(root, source), 'utf8');
      await page.setContent(`<html><style>html,body{margin:0;width:100%;height:100%}svg{display:block;width:100%;height:100%}</style><body>${svg}</body></html>`);
      await page.screenshot({ path: path.join(root, `${file}${size}.png`), omitBackground: true });
    }
  }
  await fs.copyFile(path.join(root, 'apple-touch-icon-180.png'), path.join(root, 'apple-touch-icon.png'));
  await fs.copyFile(path.join(root, 'exports/brand-overview.png'), path.join(root, 'brand-overview.png'));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/guidelines.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: path.join(root, 'exports/guidelines.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true, tagged: true });
  await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(root, 'exports/library-cover.png') });
  await page.screenshot({ path: path.join(root, 'exports/library-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(root, 'exports/library-mobile.png'), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error('Mobile brand library overflows');
  await page.locator('#asset-search').fill('business card');
  const matches = await page.locator('.asset-card').count();
  if (matches !== 2) throw new Error(`Business-card search returned ${matches} assets`);
  await page.locator('#asset-search').fill('no-such-asset-xyz');
  if (!(await page.locator('#empty-results').isVisible())) throw new Error('Empty-state search did not render');
  await page.locator('#asset-search').fill('');
  await page.locator('#asset-category').selectOption('Sector and UI icons');
  if (await page.locator('.asset-card').count() !== 24) throw new Error('Icon category is incomplete');
  await page.locator('#asset-category').selectOption('');
  // Check every gallery download link, not just previews that happened to scroll into view.
  const targets = await page.locator('.asset-links a').evaluateAll(as => as.map(a => a.href));
  for (const target of targets) {
    const r = await page.request.get(target);
    if (!r.ok()) throw new Error(`Broken gallery download: ${new URL(target).pathname}`);
  }
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  await fs.writeFile(path.join(root, 'export-index.json'), JSON.stringify({ exports, browserVerification: { assets: catalogue.assets.length, mobileWidth: 390, overflow, businessCardSearch: matches, iconCategory: 24, galleryDownloadLinks: targets.length, browserErrors: errors.length } }, null, 2) + '\n');
  console.log(`Exported ${exports.length} PNG/PDF files; verified ${targets.length} gallery downloads, mobile layout and filters.`);
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}

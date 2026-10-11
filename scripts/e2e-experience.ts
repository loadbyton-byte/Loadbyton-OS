// Run against a disposable development DB; creates a synthetic workspace.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const base = process.env.BASE ?? 'http://localhost:3000';
const out = process.env.SHOTS ?? '/tmp/loadbyton-experience'; fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: process.env.CHROME_NO_SANDBOX === 'true' ? ['--no-sandbox'] : [] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => { if (r.status() >= 400 && /\/assets\/|\/brand\//.test(r.url())) errors.push(`Asset ${r.status()} ${r.url()}`); if (r.status() >= 500) errors.push(`Server ${r.status()}`); });
  const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Horizontal overflow');
  await page.goto(base); await page.locator('.hero-image.is-active').evaluate((el: HTMLImageElement) => el.decode());
  await page.screenshot({ path: `${out}/home-desktop.png` });
  await noOverflow();
  await page.getByRole('button', { name: 'Port scene' }).click();
  assert.equal(await page.getByRole('button', { name: 'Port scene' }).getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('.hero-image.is-active').getAttribute('src') ?? '', /port/);
  await page.goto(`${base}/login`); await page.screenshot({ path: `${out}/login-desktop.png` });
  await page.getByRole('button', { name: 'Show password' }).click();
  assert.equal(await page.locator('#p').getAttribute('type'), 'text');
  await page.getByRole('button', { name: 'Hide password' }).click();
  assert.equal(await page.locator('#p').getAttribute('type'), 'password');
  await page.goto(`${base}/forgot-password`); await page.fill('#recovery-email', `unregistered-${Date.now()}@example.com`);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await page.getByRole('status').waitFor(); assert.match(await page.getByRole('status').innerText(), /If an account exists/);
  await page.goto(`${base}/start`); await page.screenshot({ path: `${out}/signup-desktop.png` });
  await page.fill('#company', 'Interface verification fixture'); await page.fill('#contact', 'Interface owner');
  await page.fill('#email', `interface-${Date.now()}@example.com`); await page.fill('#pw', 'interface-password-123');
  await page.getByRole('button', { name: 'Create my free workspace' }).click(); await page.waitForURL(/\/app/);
  await page.screenshot({ path: `${out}/workspace-desktop.png` }); await noOverflow();
  await page.getByRole('button', { name: /Find a page/ }).click();
  await page.locator('#command-query').fill('invoices');
  assert.equal(await page.locator('.command-results a:visible').count(), 1);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await page.waitForURL(/\/app\/invoices/);
  await page.keyboard.press('Control+k'); await page.getByRole('dialog').waitFor();
  await page.locator('#command-query').fill('does-not-exist'); assert.equal(await page.locator('.command-empty').isVisible(), true);
  await page.keyboard.press('Escape'); await page.locator('[data-command-dialog]').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('[data-command-dialog]').getAttribute('open'), null);
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${base}/app`);
  assert.equal(await page.locator('#workspace-sidebar').isVisible(), false);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  assert.equal(await page.locator('#workspace-sidebar').isVisible(), true);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.screenshot({ path: `${out}/workspace-mobile.png` }); await noOverflow();
  for (const path of ['/', '/login', '/start', '/enterprise', '/pricing']) {
    await page.goto(base + path); await noOverflow();
    if (path === '/') {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      assert.equal(await page.locator('#public-navigation').isVisible(), true);
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.screenshot({ path: `${out}/home-mobile.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto(base);
  assert.equal(await page.locator('.hero-copy').evaluate(el => getComputedStyle(el).animationName), 'none');
  const plain = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const nojs = await plain.newPage(); await nojs.goto(base);
  assert.equal(await nojs.locator('#public-navigation').isVisible(), true);
  assert.equal(await nojs.locator('h1').isVisible(), true);
  await nojs.goto(`${base}/login`); assert.equal(await nojs.locator('form[action="/login"]').isVisible(), true);
  assert.deepEqual(errors, []);
  console.log('Interface acceptance passed: scenes, password visibility, recovery request, signup, page search, keyboard navigation, mobile menus, responsive layouts, reduced motion and no-JS navigation.');
} finally { await browser.close(); }

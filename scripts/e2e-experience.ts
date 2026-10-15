// Run against a disposable development DB; creates a synthetic workspace. CHROME=/path/to/chromium BASE=http://localhost:3000 npm run e2e:experience
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const base = process.env.BASE ?? 'http://localhost:3000';
const out = process.env.SHOTS ?? '/tmp/loadbyton-experience'; fs.mkdirSync(out, { recursive: true });
const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...(process.env.CHROME_NO_SANDBOX === 'true' ? ['--no-sandbox'] : [])];
const browser = await chromium.launch({ executablePath: process.env.CHROME, args });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('response', r => { if (r.status() >= 400 && /\/assets\/|\/brand\//.test(r.url())) errors.push(`Asset ${r.status()} ${r.url()}`); if (r.status() >= 500) errors.push(`Server ${r.status()}`); });
  const noOverflow = async (label = '') => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `Horizontal overflow ${label}`);

  // home: glass header, cinematic hero film, offer bar, wordmark, contact points
  await page.goto(base); await page.waitForSelector('.hero-film .film-scene.is-active', { timeout: 20000 });
  assert.equal(await page.locator('.hero-film .film-scene').count(), 3, 'three hero scenes');
  // the film advances by itself every 8 s; stop it so a slow runner cannot move to another scene before the next step
  await page.locator('[data-film-toggle]').click();
  await page.locator('.film-tab').nth(1).click(); await page.waitForSelector('.hero-film .film-scene[data-scene="1"].is-active', { timeout: 15000 });
  assert.equal(await page.locator('.load-record').getAttribute('data-stage'), '4', 'load record follows the scene');
  await page.waitForTimeout(1200); await page.screenshot({ path: `${out}/home-desktop.png` }); await noOverflow('home');
  assert.ok(await page.locator('.site-head .bar').isVisible());
  assert.ok((await page.locator('.lbt').count()) > 3, 'wordmark drawn as the logo');
  assert.match(await page.locator('footer.site').innerText(), /info@loadbyton\.com/);
  assert.match(await page.locator('a.wa-mini').getAttribute('href') ?? '', /wa\.me\/919661053007/);
  assert.equal(await page.locator('[data-offer] [data-cd]').isVisible(), true);

  // assistant + live chat
  await page.locator('.chat-fab').click();
  await page.locator('[data-suggest] button', { hasText: 'How much' }).click();
  await page.locator('.msg.bot', { hasText: 'AED' }).first().waitFor();
  await page.fill('#lbt-chat-input', 'do you file customs declarations'); await page.keyboard.press('Enter');
  await page.locator('.msg.bot', { hasText: 'does not file anything' }).waitFor();
  await page.locator('[data-tab="live"]').click();
  await page.fill('#lc-name', 'Interface check'); await page.fill('#lc-msg', 'Hello from the acceptance run.'); await page.locator('[data-start]').click();
  await page.locator('.msg.me', { hasText: 'acceptance run' }).waitFor();
  await page.screenshot({ path: `${out}/chat.png` });
  await page.keyboard.press('Escape');

  // sign-in, recovery, sign-up
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

  // workspace: dashboard, hub, alerts, command search, theme
  await page.screenshot({ path: `${out}/workspace-desktop.png` }); await noOverflow('workspace');
  assert.ok(await page.locator('.dashboard-metrics .metric').count() >= 4);
  assert.match(await page.locator('main').innerText(), /Getting started/);
  await page.locator('[data-alerts]').click(); await page.locator('.popover .list').first().waitFor(); await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Workspaces', exact: true }).first().click(); await page.waitForURL(/\/app\/workspaces/);
  assert.ok(await page.locator('.workspace-card').count() >= 3); await page.screenshot({ path: `${out}/workspaces.png` });
  await page.locator('.rail-shortcut', { hasText: 'Money' }).click();
  await page.locator('dialog.workspace-popup[open]').waitFor(); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Find a page/ }).click();
  await page.locator('#command-query').fill('invoices');
  assert.equal(await page.locator('.command-results a:visible').count(), 1);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await page.waitForURL(/\/app\/invoices/);
  await page.keyboard.press('Control+k'); await page.getByRole('dialog').waitFor();
  await page.locator('#command-query').fill('does-not-exist'); assert.equal(await page.locator('.command-empty').isVisible(), true);
  await page.keyboard.press('Escape'); await page.locator('[data-command-dialog]').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /Switch light or dark theme/ }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark'); await page.screenshot({ path: `${out}/workspace-dark.png` });
  await page.getByRole('button', { name: /Switch light or dark theme/ }).click();

  // phones
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${base}/app`);
  assert.equal(await page.locator('.workspace-rail').isVisible(), true, 'rail becomes a bottom bar');
  await page.screenshot({ path: `${out}/workspace-mobile.png` }); await noOverflow('workspace mobile');
  for (const path of ['/', '/login', '/start', '/enterprise', '/pricing', '/about', '/features', '/contact', '/sectors', '/blog']) {
    await page.goto(base + path); await noOverflow(path);
    if (path === '/') {
      await page.locator('[data-site-menu]').click();
      assert.equal(await page.locator('#sheet-menu').isVisible(), true);
      await page.locator('[data-site-menu]').click();
      await page.screenshot({ path: `${out}/home-mobile.png`, fullPage: true });
    }
  }

  // reduced motion, and no JavaScript
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto(base);
  assert.equal(await page.locator('[data-reveal]').first().evaluate(el => getComputedStyle(el).opacity), '1');
  const plain = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 900 } });
  const nojs = await plain.newPage(); await nojs.goto(base);
  assert.equal(await nojs.locator('#public-navigation').isVisible(), true);
  assert.equal(await nojs.locator('h1').first().isVisible(), true);
  assert.equal(await nojs.locator('[data-reveal]').first().evaluate(el => getComputedStyle(el).opacity), '1', 'content is visible without JavaScript');
  await nojs.goto(`${base}/login`); assert.equal(await nojs.locator('form[action="/login"]').isVisible(), true);
  assert.deepEqual(errors, []);
  console.log('Interface acceptance passed: 3D hero, chat, offers, sign-in, recovery, sign-up, dashboard, workspaces hub, alerts, command search, dark theme, phone layouts, reduced motion and no-JS rendering.');
} finally { await browser.close(); }

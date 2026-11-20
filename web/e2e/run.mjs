// Playwright smoke run against the mock serving the production build.
//   npm run build && npm run e2e
// Uses the gstack Playwright install (PLAYWRIGHT_PATH overrides it).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

const require = createRequire(import.meta.url);
const pwPath = process.env.PLAYWRIGHT_PATH ?? `${homedir()}/.claude/skills/gstack/node_modules/playwright`;
const { chromium } = require(pwPath);

const PORT = 4481;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'test-results';
mkdirSync(OUT, { recursive: true });

const mock = spawn(process.execPath, ['mock/server.mjs', '--port', String(PORT), '--static', '../public/app', '--quiet'], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => mock.stdout.once('data', r));

let failed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`);
  }
};

const browser = await chromium.launch({ chromiumSandbox: false });
try {
  for (const [label, viewport, colorScheme] of [['desktop', { width: 1280, height: 800 }, 'dark'], ['mobile', { width: 375, height: 740 }, 'light']]) {
    console.log(label);
    // Reduced motion makes layer screenshots deterministic (no mid-fade frames).
    const page = await browser.newPage({ viewport, colorScheme, reducedMotion: 'reduce' });
    const shot = (n) => page.screenshot({ path: `${OUT}/${label}-${n}.png`, fullPage: true, animations: 'disabled' });
    await page.goto(BASE + '/', { waitUntil: 'load' });

    await step('wrong password shows an error', async () => {
      await page.fill('#username', 'ops');
      await page.fill('#password', 'nope');
      await page.click('button[type=submit]');
      await page.waitForSelector('[data-testid=login-error]');
      await shot('01-login-error');
    });
    await step('login with 2FA', async () => {
      await page.fill('#password', 'outband');
      await page.click('button[type=submit]');
      await page.waitForSelector('#code');
      await shot('02-2fa');
      await page.fill('#code', '123456');
      await page.click('button[type=submit]');
      await page.waitForSelector('[data-testid=device-list]');
    });
    await step('device list and live carrier', async () => {
      await page.waitForSelector('[data-testid=carrier][data-state=live]');
      const n = await page.locator('[data-testid=device-list] li').count();
      if (n !== 4) throw new Error(`expected 4 devices, got ${n}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) throw new Error('horizontal scroll');
      await shot('03-devices');
    });
    await step('live event updates a light', async () => {
      await fetch(`${BASE}/__mock/emit`, { method: 'POST', headers: { 'x-outband': '1' }, body: JSON.stringify({ id: 'devNas0100000002', online: false }) });
      await page.waitForSelector('[data-testid=device-list] li:has-text("nas01") .light[data-on=false]:has-text("IB")');
      await fetch(`${BASE}/__mock/emit`, { method: 'POST', headers: { 'x-outband': '1' }, body: JSON.stringify({ id: 'devNas0100000002', online: true }) });
    });
    await step('palette opens with Ctrl-K and filters', async () => {
      await page.keyboard.press('Control+k');
      await page.waitForSelector('[data-testid=palette]');
      await page.keyboard.type('web01 restart');
      await page.waitForSelector('.palette-item:has-text("Restart")');
      await shot('04-palette');
      await page.keyboard.press('Escape');
    });
    await step('detail + power action with confirm and toast', async () => {
      await page.click('text=amt-node01');
      await page.waitForSelector('button:has-text("Power on")');
      await page.click('button:has-text("Power on")');
      await page.waitForSelector('.toast:has-text("Power on sent")');
      await page.waitForSelector('button:has-text("Power cycle")', { timeout: 5000 });
      await page.click('button:has-text("Power off (hard)")');
      await page.waitForSelector('[data-testid=confirm-dialog]:has-text("amt-node01")');
      await shot('05-confirm');
      await page.click('[data-testid=confirm-power]');
      await page.waitForSelector('.toast:has-text("Power off (hard) sent")');
      await shot('06-toast');
    });
    await step('404 page', async () => {
      await page.goto(BASE + '/nope', { waitUntil: 'load' });
      await page.waitForSelector('text=No signal at this address');
      await shot('07-404');
    });
    await step('logout', async () => {
      await page.click('[data-testid=user-menu]');
      await page.click('[data-testid=logout]');
      await page.waitForSelector('#username');
    });
    await page.close();
  }
} finally {
  await browser.close();
  mock.kill();
}
console.log(failed ? `${failed} step(s) failed` : 'all steps passed');
process.exit(failed ? 1 : 0);

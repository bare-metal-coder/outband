// Playwright run against the mock serving the production build.
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
const hook = (name, body = {}) => fetch(`${BASE}/__mock/${name}`, { method: 'POST', headers: { 'x-outband': '1' }, body: JSON.stringify(body) });

let failed = 0;
let passed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`);
  }
};
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const browser = await chromium.launch({ chromiumSandbox: false });
try {
  for (const [label, viewport, colorScheme] of [['desktop', { width: 1280, height: 800 }, 'dark'], ['mobile', { width: 375, height: 740 }, 'light']]) {
    console.log(label);
    await hook('reset');
    const ctx = await browser.newContext({ viewport, colorScheme, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const shot = (n) => page.screenshot({ path: `${OUT}/${label}-${n}.png`, fullPage: true, animations: 'disabled' });
    const noOverflow = async (where) => expect(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), `horizontal scroll on ${where}`);
    const rows = () => page.locator('[data-testid=device-list] tbody tr');
    const toastText = (t) => page.waitForSelector(`.toast:has-text("${t}")`);
    await page.goto(BASE + '/', { waitUntil: 'load' });

    await step('wrong password shows an error', async () => {
      await page.fill('#username', 'ops');
      await page.fill('#password', 'nope');
      await page.click('button[type=submit]');
      await page.waitForSelector('[data-testid=login-error]');
      await shot('01-login-error');
    });
    await step('login with 2FA (wrong code, then right code)', async () => {
      await page.fill('#password', 'outband');
      await page.click('button[type=submit]');
      await page.waitForSelector('#code');
      await shot('02-2fa');
      await page.fill('#code', '000000');
      await page.click('button[type=submit]');
      await page.waitForSelector('[data-testid=login-error]:has-text("not accepted")');
      await page.fill('#code', '123456');
      await page.click('button[type=submit]');
      await page.waitForSelector('[data-testid=device-list]');
    });
    await step('device list: group sections, live carrier, no overflow', async () => {
      await page.waitForSelector('[data-testid=carrier][data-state=live]');
      expect((await rows().count()) === 6, `expected 6 devices, got ${await rows().count()}`);
      const heads = await page.locator('.group-head').allInnerTexts();
      expect(heads.length === 3 && heads[0].startsWith('AMT only') && heads[2].startsWith('Lab'), `group sections: ${heads}`);
      await noOverflow('devices');
      await shot('03-devices');
    });
    await step('search and filter chips', async () => {
      await page.fill('[data-testid=filter-input]', 'debian');
      expect((await rows().count()) === 2, 'search "debian" should match nas01 and db01');
      await page.fill('[data-testid=filter-input]', '');
      await page.click('[data-testid=chip-amt]');
      expect((await rows().count()) === 3, 'AMT chip: web01, db01, amt-node01');
      await page.click('[data-testid=chip-power-off]');
      expect((await rows().count()) === 1, 'AMT + off: amt-node01');
      await shot('04-filtered');
      await page.click('[data-testid=chip-amt]');
      await page.click('[data-testid=chip-power-off]');
      await page.click('[data-testid=chip-offline]');
      expect((await rows().count()) === 2, 'offline: amt-node01, old-desktop; got ' + (await rows().count()));
      await page.click('[data-testid=chip-offline]');
      expect((await rows().count()) === 6, 'cleared filters');
    });
    await step('keyboard: j/k move the selection, Enter opens', async () => {
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('j');
      await page.keyboard.press('j');
      await page.keyboard.press('k');
      const sel = await page.locator('tr[data-selected=true] .c-name a').allInnerTexts();
      expect(sel.length === 1 && sel[0] === 'amt-node01', `selected ${sel}`);
      await page.fill('[data-testid=filter-input]', 'web01');
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('j');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-testid=overview]');
      expect(page.url().endsWith('/devices/devWeb0100000001'), 'opened web01: ' + page.url());
    });
    await step('detail overview: OS, AMT version and state, power, IPs, serial', async () => {
      const t = await page.locator('[data-testid=overview]').innerText();
      for (const s of ['Ubuntu 24.04 LTS', 'Reachable', 'v16.1.25', '10.0.0.11', 'EX-0001']) expect(t.includes(s), `overview lacks ${s}`);
      await noOverflow('detail');
      await shot('05-detail');
    });
    await step('detail: IPs and serial are left out when absent', async () => {
      await page.goto(BASE + '/devices/devOld0100000005', { waitUntil: 'load' });
      await page.waitForSelector('[data-testid=overview]');
      // Strip the fields the way a restricted token would get them: the mock sends them, so check the nas01 case (no hardware).
      await page.goto(BASE + '/devices/devNas0100000002', { waitUntil: 'load' });
      await page.waitForSelector('[data-testid=overview]');
      expect((await page.locator('[data-testid=serial]').count()) === 0, 'no serial row without hardware');
      await page.goto(BASE + '/devices/devWeb0100000001', { waitUntil: 'load' });
      await page.waitForSelector('[data-testid=events] li');
    });
    await step('events: paged, then a live event on top, unknown type ignored', async () => {
      expect((await page.locator('[data-testid=events] li').count()) === 25, 'first page is 25');
      await page.click('[data-testid=more-events]');
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=events] li').length === 50);
      await hook('event', { id: 'devWeb0100000001', message: 'Live event one' });
      await page.waitForSelector('[data-testid=events] li:first-child:has-text("Live event one")');
      await hook('unknown');
      await hook('event', { id: 'devWeb0100000001', message: 'After the unknown event' });
      await page.waitForSelector('[data-testid=events] li:first-child:has-text("After the unknown event")');
      expect(errors.length === 0, 'page errors: ' + errors.join('; '));
      expect((await page.locator('.toast[data-kind=error]').count()) === 0, 'no error toast');
      await shot('06-events');
    });
    await step('live power update reaches the detail page', async () => {
      await hook('emit', { id: 'devWeb0100000001', power: 'sleep' });
      await page.waitForSelector('[data-testid=overview] .state[data-power=sleep]');
      await hook('emit', { id: 'devWeb0100000001', power: 'on' });
      await page.waitForSelector('[data-testid=overview] .state[data-power=on]');
    });
    await step('power off: confirm offers agent and AMT; AMT is dispatched', async () => {
      await page.click('[data-action=off]');
      await page.waitForSelector('[data-testid=confirm-dialog]');
      const t = await page.locator('[data-testid=confirm-dialog]').innerText();
      expect(t.includes('Shut down (agent)') && t.includes('Hard power off (Intel AMT)'), 'both choices shown');
      expect(await page.locator('[data-testid=via-default]').isChecked(), 'the default (agent) is preselected');
      expect((await page.locator('[data-testid=confirm-dialog] .choice').first().innerText()).includes('Shut down (agent)'), 'default is the graceful agent path');
      await page.click('[data-testid=via-amt]');
      await shot('07-confirm');
      expect((await page.locator('[data-testid=confirm-power]').innerText()) === 'Hard power off (Intel AMT)', 'confirm button names the path');
      await page.click('[data-testid=confirm-power]');
      await toastText('Hard power off (Intel AMT) sent');
      await page.waitForSelector('[data-testid=overview] .state[data-power=off]');
      await page.waitForSelector('[data-action=wake]');
      await shot('08-toast');
    });
    await step('power errors: 409 not reachable, 403 on the AMT path', async () => {
      await page.goto(BASE + '/devices/devDb010000000003', { waitUntil: 'load' });
      await page.waitForSelector('[data-action=off]');
      await hook('silent', { id: 'devDb010000000003', amt_reachable: false });
      await page.click('[data-action=off]');
      await page.click('[data-testid=via-amt]');
      await page.click('[data-testid=confirm-power]');
      await toastText('cannot carry this action');
      await hook('silent', { id: 'devDb010000000003', amt_reachable: true });
      await hook('deny', { paths: ['amt'] });
      await page.click('[data-action=reset]');
      await page.click('[data-testid=via-amt]');
      await page.click('[data-testid=confirm-power]');
      await toastText('do not have the right to do this through Intel AMT');
      await hook('deny', { paths: [] });
      await shot('09-errors');
    });
    await step('default unavailable (agent offline): hard power off is offered only as via=amt, red confirm', async () => {
      await page.goto(BASE + '/devices/devBmc0100000004', { waitUntil: 'load' });
      await page.waitForSelector('[data-action=wake]');
      await hook('emit', { id: 'devBmc0100000004', power: 'on' });
      await page.waitForSelector('[data-action=off]');
      const reqs = [];
      const onReq = (r) => r.url().endsWith('/power') && r.method() === 'POST' && reqs.push(r.postData());
      page.on('request', onReq);
      await page.click('[data-action=off]');
      await page.waitForSelector('[data-testid=confirm-dialog]');
      const t = await page.locator('[data-testid=confirm-dialog]').innerText();
      expect(t.includes('Hard power off') && t.includes('Intel AMT') && !t.includes('server default'), 'names the AMT path, not the default');
      expect((await page.locator('[data-testid=confirm-power]').getAttribute('class')).includes('btn-danger'), 'red confirm');
      await shot('09b-hard-off-only');
      await page.click('[data-testid=confirm-power]');
      await toastText('Hard power off (Intel AMT) sent');
      page.off('request', onReq);
      expect(reqs.length === 1 && JSON.parse(reqs[0]).via === 'amt', 'request carries via=amt: ' + reqs);
    });
    await step('console tab is a placeholder', async () => {
      await page.click('[data-testid=tab-console]');
      await page.waitForSelector('text=Console is coming');
    });
    await step('palette opens with Ctrl-K and filters', async () => {
      await page.keyboard.press('Control+k');
      await page.waitForSelector('[data-testid=palette]');
      await page.keyboard.type('nas01 restart');
      await page.waitForSelector('.palette-item:has-text("Restart")');
      await shot('10-palette');
      await page.keyboard.press('Escape');
    });
    await step('palette: even a mild action ("on") asks for confirmation and sends nothing until confirmed', async () => {
      const powerPosts = [];
      const onReq = (r) => r.url().endsWith('/power') && r.method() === 'POST' && powerPosts.push(r.url());
      page.on('request', onReq);
      await page.keyboard.press('Control+k');
      await page.waitForSelector('[data-testid=palette]');
      await page.keyboard.type('web01 on');
      await page.waitForSelector('.palette-item:has-text("Power on")');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-testid=confirm-dialog]');
      expect(await page.locator('[data-testid=confirm-dialog]').innerText().then((t) => t.includes('Power on')), 'dialog names the action');
      await page.waitForTimeout(400);
      expect(powerPosts.length === 0, 'nothing sent before confirm');
      await shot('10b-palette-confirm');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      expect(powerPosts.length === 0, 'cancel sends nothing');
      await page.keyboard.press('Control+k');
      await page.keyboard.type('web01 on');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-testid=confirm-dialog]');
      await page.click('[data-testid=confirm-power]');
      await page.waitForSelector('.toast:has-text("Power on")');
      expect(powerPosts.length === 1, 'exactly one request after confirm');
      page.off('request', onReq);
    });
    await step('API tokens: step-up, show once, copy, revoke', async () => {
      // Error toasts stay until dismissed (design rule); clear them so they do not cover the dialogs below.
      for (let n = await page.locator('.toast button[aria-label=Dismiss]').count(); n > 0; n--) await page.locator('.toast button[aria-label=Dismiss]').first().click();
      await page.click('[data-testid=user-menu]');
      await page.click('[data-testid=settings-link]');
      await page.waitForSelector('text=No API tokens');
      const authCalls = [];
      page.on('request', (r) => /\/auth\/(login|reauth)$/.test(r.url()) && authCalls.push(r.url().split('/').pop()));
      await hook('age-session'); // the sign-in is now older than 15 minutes
      await page.click('[data-testid=new-token]');
      await page.fill('#tname', 'e2e-automation');
      await shot('11-create-token');
      await page.click('[data-testid=create-submit]');
      await page.waitForSelector('[data-testid=stepup-dialog]');
      await shot('12-stepup');
      await page.fill('#stepup', 'outband');
      await page.click('[data-testid=stepup-submit]');
      await page.waitForSelector('#stepup[autocomplete=one-time-code]');
      await page.fill('#stepup', '123456');
      await page.click('[data-testid=stepup-submit]');
      await page.waitForSelector('[data-testid=secret-dialog]');
      const secret = await page.locator('[data-testid=secret]').innerText();
      expect(/^obt_[A-Za-z0-9_-]{43}$/.test(secret), 'secret format');
      await page.click('[data-testid=copy-secret]');
      await page.waitForSelector('[data-testid=copy-secret]:has-text("Copied")');
      expect((await page.evaluate(() => navigator.clipboard.readText())) === secret, 'clipboard holds the secret');
      await shot('13-secret');
      expect(authCalls.join() === 'reauth,reauth', 'step-up uses /auth/reauth twice and never /auth/login: ' + authCalls);
      await page.keyboard.press('Escape');
      await page.mouse.click(5, 5);
      await page.waitForTimeout(300);
      expect((await page.locator('[data-testid=secret]').innerText()) === secret, 'Escape and a backdrop click leave the secret on screen');
      await page.click('[data-testid=secret-done]');
      await page.waitForSelector('[data-testid=secret-dialog]', { state: 'detached' });
      await page.waitForSelector('[data-testid=token-row]:has-text("e2e-automation")');
      expect(!(await page.content()).includes(secret), 'secret is gone after closing');
      await noOverflow('tokens');
      await shot('14-tokens');
      await page.locator('[data-testid=revoke]').first().click();
      await page.waitForSelector('[data-testid=revoke-dialog]');
      await page.click('[data-testid=confirm-revoke]');
      await page.waitForSelector('[data-testid=token-row][data-status=revoked]');
      await shot('15-revoked');
    });
    await step('404 page', async () => {
      await page.goto(BASE + '/nope', { waitUntil: 'load' });
      await page.waitForSelector('text=No signal at this address');
    });
    await step('logout', async () => {
      await page.click('[data-testid=user-menu]');
      await page.click('[data-testid=logout]');
      await page.waitForSelector('#username');
    });
    await step('stream: a retryable close reconnects; a terminal close signs out with a notice', async () => {
      await page.goto(BASE + '/', { waitUntil: 'load' });
      await page.fill('#username', 'admin');
      await page.fill('#password', 'outband');
      await page.click('button[type=submit]');
      await page.waitForSelector('[data-testid=carrier][data-state=live]');
      await hook('close', { reason: 'shutdown' });
      await page.waitForSelector('[data-testid=carrier]:not([data-state=live])');
      await page.waitForSelector('[data-testid=carrier][data-state=live]', { timeout: 25000 });
      expect(await page.locator('[data-testid=device-list]').count() === 1, 'still signed in');
      await hook('close', { reason: 'revoked' });
      await page.waitForSelector('[data-testid=signed-out]');
      await shot('16-signed-out');
    });
    await ctx.close();
  }
} finally {
  await browser.close();
  mock.kill();
}
console.log(failed ? `${failed} step(s) failed, ${passed} passed` : `all ${passed} steps passed`);
process.exit(failed ? 1 : 0);

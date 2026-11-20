/**
 * Live tests against a real MeshCentral process on 127.0.0.1:4431 with a
 * throwaway data directory (.outband-test/, git-ignored). Contacts no other host.
 * Enabled with OUTBAND_LIVE=1 (CI sets it).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, execFileSync } = require('child_process');
const { check } = require('./contract');

const LIVE = process.env.OUTBAND_LIVE == '1';
const ROOT = path.join(__dirname, '../..');
const BASE = path.join(ROOT, '.outband-test');
const PORT = 4431;
const NAME = 'outband.example.com';
const HOST = NAME + ':' + PORT;
const ORIGIN = 'https://' + HOST;
const PASS = { admin: 'Admin-Live-Pass-1', alice: 'Alice-Live-Pass-1', bob: 'Bob-Live-Pass-1' };

function config(extra) {
    return {
        settings: Object.assign({
            cert: NAME, port: PORT, portBind: '127.0.0.1', redirPort: 0, aliasPort: PORT, exactPorts: true, mpsPort: 0,
            selfUpdate: false, noAgentUpdate: true, WANonly: true, agentDownloads: { enabled: false },
            maxInvalidLogin: { time: 10, count: 1000, coolofftime: 10 },
            sessionKey: require('crypto').randomBytes(32).toString('hex') // stable across restarts, so old cookies can be sent again
        }, extra || {}),
        domains: { '': { title: 'Outband live test' } }
    };
}

function mc(dir, args) { return execFileSync(process.execPath, [path.join(ROOT, 'meshcentral.js'), '--datapath', dir].concat(args), { cwd: ROOT, stdio: 'pipe', timeout: 180000 }).toString(); }

/** Prepare a data directory with users admin, alice and bob (bob has TOTP). */
function prepare(name, extraSettings) {
    const dir = path.join(BASE, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config(extraSettings), null, 1));
    const certCache = path.join(BASE, 'certs');
    if (fs.existsSync(certCache)) { for (const f of fs.readdirSync(certCache)) fs.copyFileSync(path.join(certCache, f), path.join(dir, f)); }
    mc(dir, ['--createaccount', 'admin', '--pass', PASS.admin, '--email', 'admin@example.com']);
    mc(dir, ['--adminaccount', 'admin']);
    mc(dir, ['--createaccount', 'alice', '--pass', PASS.alice, '--email', 'alice@example.com']);
    mc(dir, ['--createaccount', 'bob', '--pass', PASS.bob, '--email', 'bob@example.com']);
    // Give bob a TOTP secret: NeDB loads the last line for an _id.
    const dbFile = path.join(dir, 'meshcentral.db');
    const lines = fs.readFileSync(dbFile, 'utf8').split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); });
    const bob = lines.filter(function (d) { return d._id == 'user//bob'; }).pop();
    const secret = require('otplib').generateSecret();
    bob.otpsecret = secret;
    fs.appendFileSync(dbFile, JSON.stringify(bob) + '\n');
    return { dir: dir, totp: secret };
}

function request(method, p, o) {
    o = o || {};
    const headers = Object.assign({ host: HOST }, o.headers || {});
    let body = null;
    if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json'; }
    if (body != null) headers['content-length'] = Buffer.byteLength(body);
    if (o.cookie) headers.cookie = o.cookie;
    if (o.csrf) { headers['x-outband'] = '1'; headers.origin = ORIGIN; }
    if (o.bearer) headers.authorization = 'Bearer ' + o.bearer;
    return new Promise(function (resolve, reject) {
        const req = https.request({ host: '127.0.0.1', port: PORT, servername: NAME, method: method, path: p, headers: headers, rejectUnauthorized: false, agent: false }, function (res) {
            const chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null; try { json = JSON.parse(text); } catch (ex) { }
                const cookies = (res.headers['set-cookie'] || []).map(function (c) { return c.split(';')[0]; }).filter(function (c) { return c.substring(c.indexOf('=') + 1).length > 0; });
                resolve({ status: res.statusCode, headers: res.headers, text: text, body: json, cookie: cookies.join('; ') });
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, function () { req.destroy(new Error('timeout')); });
        if (body != null) req.write(body);
        req.end();
    });
}

async function api(method, p, o) { const r = await request(method, p, o); if (p.startsWith('/api/v1')) check(method, p, r); return r; }

let proc = null;
async function startServer(dir, extraArgs) {
    try { await request('GET', '/api/v1/health'); throw new Error('Port ' + PORT + ' is already in use by another server'); } catch (ex) { if (/already in use/.test(ex.message)) throw ex; }
    proc = spawn(process.execPath, [path.join(ROOT, 'meshcentral.js'), '--datapath', dir].concat(extraArgs || []), { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', function (d) { out += d; });
    proc.stderr.on('data', function (d) { out += d; });
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
        try { const r = await request('GET', '/api/v1/health'); if (r.status == 200) return; } catch (ex) { }
        await new Promise(function (r) { setTimeout(r, 1000); });
    }
    throw new Error('MeshCentral did not start:\n' + out);
}

/** Keep the generated certificates for the next run (certificate generation is slow). */
function cacheCerts(dir) {
    const certCache = path.join(BASE, 'certs');
    if (fs.existsSync(certCache) && fs.readdirSync(certCache).length > 0) return;
    fs.mkdirSync(certCache, { recursive: true });
    for (const f of fs.readdirSync(dir)) { if (/-cert-(public|private)\.(crt|key)$/.test(f)) fs.copyFileSync(path.join(dir, f), path.join(certCache, f)); }
}
async function stopServer() {
    if (proc == null) return;
    const p = proc; proc = null;
    await new Promise(function (resolve) { p.on('exit', resolve); p.kill('SIGTERM'); setTimeout(function () { try { p.kill('SIGKILL'); } catch (ex) { } }, 10000); });
    await new Promise(function (r) { setTimeout(r, 1000); });
}

function loggedInOnLegacy(r) { return (r.status == 200) && !r.text.includes('id=loginpanel') && r.text.includes('logoutControls'); }

const liveTest = function (name, opts, fn) { if (LIVE) { test(name, opts, fn); } else { test(name + ' (set OUTBAND_LIVE=1)', function () { }); } };

liveTest('live MeshCentral', { timeout: 900000 }, async function (t) {
    const env = prepare('live');
    t.after(stopServer);
    await startServer(env.dir);
    cacheCerts(env.dir);

    let adminCookie = null, aliceCookie = null, secret = null;

    await t.test('health, availability headers, host and OPTIONS', async function () {
        const h = await api('GET', '/api/v1/health');
        assert.strictEqual(h.status, 200);
        assert.strictEqual((await api('GET', '/api/v1/session', { headers: { host: 'evil.example.net:' + PORT } })).status, 421);
        const o = await request('OPTIONS', '/api/v1/auth/login', { headers: { origin: ORIGIN } });
        assert.strictEqual(o.status, 403);
        assert.strictEqual(o.headers['access-control-allow-origin'], undefined);
        assert.strictEqual((await api('GET', '/api/v1/server')).status, 401);
    });

    await t.test('login refusals are uniform; CSRF enforced', async function () {
        const a = await api('POST', '/api/v1/auth/login', { csrf: true, json: { username: 'alice', password: 'wrong' } });
        const b = await api('POST', '/api/v1/auth/login', { csrf: true, json: { username: 'nobody', password: 'wrong' } });
        assert.strictEqual(a.status, 401); assert.strictEqual(b.status, 401);
        assert.strictEqual(a.body.error.message, b.body.error.message);
        const c = await api('POST', '/api/v1/auth/login', { json: { username: 'alice', password: PASS.alice }, headers: { 'x-outband': '1' } });
        assert.strictEqual(c.status, 403); assert.strictEqual(c.body.error.code, 'csrf_failed');
    });

    await t.test('login creates a MeshCentral session that also works on the legacy UI', async function () {
        const r = await api('POST', '/api/v1/auth/login', { csrf: true, json: { username: 'alice', password: PASS.alice } });
        assert.strictEqual(r.status, 200);
        aliceCookie = r.cookie;
        assert.ok(aliceCookie.includes('xid='));
        const s = await api('GET', '/api/v1/session', { cookie: aliceCookie });
        assert.strictEqual(s.body.authenticated, true);
        assert.strictEqual(s.body.user.id, 'alice');
        const legacy = await request('GET', '/', { cookie: aliceCookie });
        assert.ok(loggedInOnLegacy(legacy), 'legacy UI accepts the API session');
        const srv = await api('GET', '/api/v1/server', { cookie: aliceCookie });
        assert.strictEqual(srv.status, 200);
        assert.strictEqual(srv.body.api_version, '1.0.0-draft.7');
    });

    await t.test('2FA with TOTP: pending login authenticates nothing, then a full session', async function () {
        const r = await api('POST', '/api/v1/auth/login', { csrf: true, json: { username: 'bob', password: PASS.bob } });
        assert.strictEqual(r.status, 200); assert.strictEqual(r.body.authenticated, false);
        const pending = r.cookie;
        assert.strictEqual((await api('GET', '/api/v1/server', { cookie: pending })).status, 401);
        assert.ok(!loggedInOnLegacy(await request('GET', '/', { cookie: pending })), 'pending login is not a legacy session either');
        const wrong = await api('POST', '/api/v1/auth/2fa', { csrf: true, cookie: pending, json: { code: '000000' } });
        assert.strictEqual(wrong.status, 401);
        const code = require('otplib').generateSync({ secret: env.totp });
        const ok = await api('POST', '/api/v1/auth/2fa', { csrf: true, cookie: pending, json: { code: code, method: 'otp' } });
        assert.strictEqual(ok.status, 200, ok.text);
        assert.strictEqual((await api('GET', '/api/v1/server', { cookie: ok.cookie })).status, 200);
    });

    await t.test('tokens over TLS, kill switch, revocation', async function () {
        const a = await api('POST', '/api/v1/auth/login', { csrf: true, json: { username: 'admin', password: PASS.admin } });
        adminCookie = a.cookie;
        const t1 = await api('POST', '/api/v1/auth/tokens', { csrf: true, cookie: adminCookie, json: { name: 'live', profile: 'device_power', expires_in_days: 30 } });
        assert.strictEqual(t1.status, 201, t1.text);
        secret = t1.body.secret;
        assert.strictEqual((await api('GET', '/api/v1/server', { bearer: secret })).status, 200);
        const sess = await api('GET', '/api/v1/session', { bearer: secret });
        assert.strictEqual(sess.body.auth_method, 'token');
        let k = await api('PUT', '/api/v1/admin/settings', { csrf: true, cookie: adminCookie, json: { bearer: false } });
        assert.strictEqual(k.status, 200);
        const off = await api('GET', '/api/v1/server', { bearer: secret });
        assert.strictEqual(off.status, 401); assert.strictEqual(off.body.error.code, 'bearer_disabled');
        k = await api('PUT', '/api/v1/admin/settings', { csrf: true, cookie: adminCookie, json: { bearer: true } });
        assert.strictEqual((await api('GET', '/api/v1/server', { bearer: secret })).status, 200);
        const del = await api('DELETE', '/api/v1/admin/tokens/' + t1.body.token.id, { csrf: true, cookie: adminCookie });
        assert.strictEqual(del.status, 204);
        const gone = await api('GET', '/api/v1/server', { bearer: secret });
        assert.strictEqual(gone.body.error.code, 'token_revoked');
    });

    await t.test('logout revokes the session everywhere, also after a restart', async function () {
        const out = await api('POST', '/api/v1/auth/logout', { csrf: true, cookie: aliceCookie });
        assert.strictEqual(out.status, 204);
        assert.strictEqual((await api('GET', '/api/v1/server', { cookie: aliceCookie })).status, 401);
        assert.ok(!loggedInOnLegacy(await request('GET', '/', { cookie: aliceCookie })), 'legacy UI refuses the logged-out session');
        await stopServer();
        await startServer(env.dir);
        assert.strictEqual((await api('GET', '/api/v1/server', { cookie: aliceCookie })).status, 401);
        assert.ok(!loggedInOnLegacy(await request('GET', '/', { cookie: aliceCookie })), 'still refused after restart');
        // The admin session survived the restart (session records are persisted)
        assert.strictEqual((await api('GET', '/api/v1/server', { cookie: adminCookie })).status, 200);
    });
});

liveTest('live MeshCentral in no-auth mode answers 503', { timeout: 600000 }, async function (t) {
    const env = prepare('live-nousers');
    t.after(stopServer);
    await startServer(env.dir, ['--nousers']);
    assert.strictEqual((await api('GET', '/api/v1/health')).status, 200);
    assert.strictEqual((await api('GET', '/api/v1/session')).status, 503);
    assert.strictEqual((await api('POST', '/api/v1/auth/login', { csrf: true, json: { username: 'admin', password: PASS.admin } })).status, 503);
});

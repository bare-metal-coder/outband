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

/** True when control.ashx accepts the cookie as a logged-in session (it sends serverinfo). */
function controlSession(cookie) {
    const WebSocket = require('ws');
    return new Promise(function (resolve) {
        let done = false;
        const finish = function (v) { if (!done) { done = true; try { ws.close(); } catch (ex) { } resolve(v); } };
        const ws = new WebSocket('wss://127.0.0.1:' + PORT + '/control.ashx', { headers: { host: HOST, cookie: cookie }, servername: NAME, rejectUnauthorized: false });
        ws.on('message', function (m) { let j = null; try { j = JSON.parse(m.toString()); } catch (ex) { } if (j && j.action == 'serverinfo') finish(true); if (j && j.action == 'close') finish(false); });
        ws.on('close', function () { finish(false); });
        ws.on('error', function () { finish(false); });
        setTimeout(function () { finish(false); }, 10000);
    });
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

    await t.test('legacy logout is persisted: refused on /api/v1, control.ashx and the legacy UI after a restart', async function () {
        const r = await api('POST', '/api/v1/auth/login', { csrf: true, json: { username: 'alice', password: PASS.alice } });
        const cookie = r.cookie;
        assert.strictEqual(await controlSession(cookie), true, 'control.ashx accepts the session before logout');
        const out = await request('GET', '/logout', { cookie: cookie });
        assert.ok(out.status < 400);
        await stopServer();
        await startServer(env.dir);
        assert.strictEqual((await api('GET', '/api/v1/server', { cookie: cookie })).status, 401);
        assert.strictEqual(await controlSession(cookie), false, 'control.ashx refuses it');
        assert.ok(!loggedInOnLegacy(await request('GET', '/', { cookie: cookie })), 'legacy UI refuses it');
    });
});

/** Add a device group, one device and a user link to a prepared data directory (NeDB: the last line per _id wins). */
function seedInventory(dir) {
    const dbFile = path.join(dir, 'meshcentral.db');
    const lines = fs.readFileSync(dbFile, 'utf8').split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); });
    const alice = lines.filter(function (d) { return d._id == 'user//alice'; }).pop();
    const meshId = 'mesh//LiveGroup0000000000000000000000000000000000000000000000000000';
    const nodeId = 'node//LiveNode00000000000000000000000000000000000000000000000000000';
    alice.links = { [meshId]: { rights: 0xFFFFFFFF } };
    const mesh = { type: 'mesh', _id: meshId, name: 'Live Group', mtype: 2, desc: 'Example group', domain: '', links: { 'user//alice': { name: 'alice', rights: 0xFFFFFFFF } } };
    const node = { type: 'node', _id: nodeId, meshid: meshId, name: 'live-node-01', host: 'live-node-01.example.com', domain: '', ip: '192.0.2.50', osdesc: 'Example OS', icon: 1, agent: { ver: 1, id: 6 }, intelamt: { state: 2, ver: '16.1.25' } };
    for (const d of [alice, mesh, node]) fs.appendFileSync(dbFile, JSON.stringify(d) + '\n');
    return { group: meshId.split('/')[2], device: nodeId.split('/')[2] };
}

/** Open the SSE stream over TLS; resolves with the status and a message list. */
function sse(o) {
    return new Promise(function (resolve, reject) {
        const headers = { host: HOST };
        if (o.cookie) headers.cookie = o.cookie;
        if (o.bearer) headers.authorization = 'Bearer ' + o.bearer;
        const req = https.request({ host: '127.0.0.1', port: PORT, servername: NAME, method: 'GET', path: '/api/v1/stream' + (o.query || ''), headers: headers, rejectUnauthorized: false, agent: false }, function (res) {
            const s = { status: res.statusCode, headers: res.headers, raw: '', messages: [], ended: false, close: function () { req.destroy(); } };
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', function (d) {
                s.raw += d; buf += d;
                let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const block = buf.substring(0, i); buf = buf.substring(i + 2);
                    const m = /^data: (.*)$/m.exec(block);
                    if (m) s.messages.push(JSON.parse(m[1]));
                }
            });
            res.on('end', function () { s.ended = true; });
            res.on('close', function () { s.ended = true; });
            s.waitFor = async function (pred, ms) { const until = Date.now() + (ms || 8000); while (Date.now() < until) { if (pred(s)) return true; await new Promise(function (r) { setTimeout(r, 25); }); } return pred(s); };
            resolve(s);
        });
        req.on('error', reject);
        req.end();
    });
}

liveTest('live MeshCentral resources: groups, devices, events, stream', { timeout: 900000 }, async function (t) {
    const env = prepare('live-resources');
    const ids = seedInventory(env.dir);
    t.after(stopServer);
    await startServer(env.dir);
    cacheCerts(env.dir);
    const login = async function (name) { const r = await api('POST', '/api/v1/auth/login', { csrf: true, json: { username: name, password: PASS[name] } }); assert.strictEqual(r.status, 200, r.text); return r.cookie; };
    const alice = await login('alice');
    const bob = await login('bob').catch(function () { return null; });

    await t.test('groups and devices as the owner of the links', async function () {
        const g = await api('GET', '/api/v1/groups', { cookie: alice });
        assert.strictEqual(g.status, 200);
        assert.deepStrictEqual(g.body.items.map(function (x) { return [x.id, x.name, x.kind, x.device_count]; }), [[ids.group, 'Live Group', 'agent', 1]]);
        assert.deepStrictEqual(g.body.items[0].rights, { mask: 4294967295, names: ['admin'] });
        assert.strictEqual((await api('GET', '/api/v1/groups/' + ids.group, { cookie: alice })).status, 200);
        const d = await api('GET', '/api/v1/devices', { cookie: alice });
        assert.strictEqual(d.status, 200);
        assert.strictEqual(d.body.items.length, 1);
        const dev = d.body.items[0];
        assert.strictEqual(dev.id, ids.device); assert.strictEqual(dev.online, false); assert.deepStrictEqual(dev.ips, ['192.0.2.50']);
        assert.strictEqual(dev.amt.state, 'provisioned'); assert.strictEqual(dev.group.id, ids.group);
        assert.strictEqual((await api('GET', '/api/v1/devices?status=online', { cookie: alice })).body.items.length, 0);
        assert.strictEqual((await api('GET', '/api/v1/devices?q=LIVE-NODE', { cookie: alice })).body.items.length, 1);
        const one = await api('GET', '/api/v1/devices/' + ids.device, { cookie: alice });
        assert.strictEqual(one.status, 200); assert.strictEqual(one.body.agent.type, 6);
        assert.strictEqual((await api('GET', '/api/v1/devices/' + ids.device + '/events', { cookie: alice })).status, 200);
        assert.strictEqual((await api('GET', '/api/v1/events', { cookie: alice })).status, 200);
    });

    await t.test('a user without links sees nothing; tokens follow their scopes and groups', async function () {
        const adminCookie = await login('admin');
        assert.strictEqual((await api('GET', '/api/v1/devices/' + ids.device, { cookie: adminCookie })).status, 404);
        assert.strictEqual((await api('GET', '/api/v1/groups/' + ids.group, { cookie: adminCookie })).status, 404);
        assert.deepStrictEqual((await api('GET', '/api/v1/devices', { cookie: adminCookie })).body.items, []);
        const tk = await api('POST', '/api/v1/auth/tokens', { csrf: true, cookie: alice, json: { name: 'live-power', profile: 'device_power', groups: [ids.group] } });
        assert.strictEqual(tk.status, 201, tk.text);
        const dd = await api('GET', '/api/v1/devices/' + ids.device, { bearer: tk.body.secret });
        assert.strictEqual(dd.status, 200);
        assert.ok(!('ips' in dd.body)); assert.ok(!dd.text.includes('192.0.2.50'));
        const ev = await api('GET', '/api/v1/events?limit=5', { bearer: tk.body.secret });
        assert.strictEqual(ev.status, 200);
        assert.ok(ev.body.items.every(function (e) { return !e.user || e.user.redacted === true; }));
        assert.ok(ev.body.items.every(function (e) { return e.source_ip == null; }));
        assert.strictEqual((await api('GET', '/api/v1/devices/' + ids.device + 'x', { bearer: tk.body.secret })).status, 404);
    });

    await t.test('stream: ready, and it ends with closed within 5 seconds of a revocation', async function () {
        const tk = await api('POST', '/api/v1/auth/tokens', { csrf: true, cookie: alice, json: { name: 'live-stream', scopes: ['read'] } });
        const s = await sse({ bearer: tk.body.secret, query: '?types=device.power,device.updated,resync' });
        assert.strictEqual(s.status, 200);
        assert.match(s.headers['content-type'], /^text\/event-stream/);
        assert.ok(await s.waitFor(function (x) { return x.messages.some(function (m) { return m.type == 'ready'; }); }));
        assert.ok(s.raw.startsWith('retry: 5000'));
        const t0 = Date.now();
        const del = await api('DELETE', '/api/v1/auth/tokens/' + tk.body.token.id, { csrf: true, cookie: alice });
        assert.strictEqual(del.status, 204);
        assert.ok(await s.waitFor(function (x) { return x.messages.some(function (m) { return m.type == 'closed'; }); }, 5000));
        assert.ok(Date.now() - t0 < 5000);
        assert.strictEqual(s.messages.filter(function (m) { return m.type == 'closed'; })[0].data.reason, 'revoked');
        // a session stream ends on logout, and frees its slot
        const c2 = await login('alice');
        const s2 = await sse({ cookie: c2 });
        assert.ok(await s2.waitFor(function (x) { return x.messages.length > 0; }));
        await api('POST', '/api/v1/auth/logout', { csrf: true, cookie: c2 });
        assert.ok(await s2.waitFor(function (x) { return x.messages.some(function (m) { return m.type == 'closed' && m.data.reason == 'logout'; }); }, 5000));
        void bob;
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

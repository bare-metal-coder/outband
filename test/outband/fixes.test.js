/**
 * Tests for: legacy logout persistence, session-bound cookies, per-user
 * not_before, limiter eviction, store file modes, forwarding headers, 2FA
 * completion re-checks, central scope checks, retention and erasure, and
 * secrets in logs.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, FULL } = require('./harness');
const { check } = require('./contract');
const { FailureLock, WindowLimiter } = require('../../outband/ratelimit');
const { openStore } = require('../../outband/store');
const { checkHost } = require('../../outband/hostorigin');
const { isSecureRequest } = require('../../outband/util');
const power = require('../../outband/power');

const users = { admin: { password: 'Admin-Pass-1', siteadmin: FULL }, alice: { password: 'Alice-Pass-1' }, bob: { password: 'Bob-Pass-1', otpsecret: 'S', testcode: '123456' } };

async function withServer(opts, fn) { const h = await start(opts); try { await fn(h); } finally { await h.close(); } }
async function call(c, method, p, o) { const fn = { GET: 'get', POST: 'post', PUT: 'put', DELETE: 'del' }[method]; const r = await c[fn](p, o); check(method, p, r); return r; }
function onlyRecord(h, uid) { return [...h.core.sessions.records.values()].find(function (r) { return r.u == uid; }); }

test('legacy logout is persisted and cancels tickets', async function () {
    await withServer({ users }, async function (h) {
        const c = h.client();
        await c.login('alice', users.alice.password);
        const rec = onlyRecord(h, 'user//alice');
        const t = h.core.tickets.issue({ userid: rec.u, deviceId: 'd', kind: 'sol', credentialKey: 'ses:' + rec.u + '/' + rec.x, cookie: true });
        h.core.onLogout(rec.u, rec.x);
        await new Promise(function (r) { setTimeout(r, 20); });
        assert.strictEqual((await call(c, 'GET', '/api/v1/server')).status, 401);
        assert.strictEqual(h.core.tickets.consume(t.ticket, 'd', 'sol'), null);
        const rev = await h.core.store.revocations.find({ k: rec.u + '/' + rec.x });
        assert.strictEqual(rev.length, 1, 'revocation persisted');
    });
});

test('session-bound cookies: ended sessions and destroyed sessions refused; x required where a session is expected', async function () {
    await withServer({ users }, async function (h) {
        const c = h.client();
        await c.login('alice', users.alice.password);
        const rec = onlyRecord(h, 'user//alice');
        assert.strictEqual(h.core.checkAuthCookie({ ruserid: rec.u, x: rec.x }), true);
        assert.strictEqual(h.core.checkAuthCookie({ userid: rec.u, nodeid: 'n' }, true), false, 'no session id where one is required');
        assert.strictEqual(h.core.checkAuthCookie({ ruserid: rec.u }), true, 'agent-side cookies carry no session id');
        h.webserver.destroyedSessions[rec.u + '/' + rec.x] = Date.now();
        assert.strictEqual(h.core.checkAuthCookie({ ruserid: rec.u, x: rec.x }), false);
        assert.strictEqual(h.core.checkAuthCookie({ userid: rec.u, x: 'unknown' }, true), false);
        assert.strictEqual(h.core.checkAuthCookie(null), false);
    });
});

test('not_before: an admin "change at next login" reset ends sessions and tokens, which list as revoked', async function () {
    await withServer({ users }, async function (h) {
        const c = h.client();
        await c.login('alice', users.alice.password);
        const tok = await c.post('/api/v1/auth/tokens', { json: { name: 'ro', scopes: ['read'] } });
        const b = h.client();
        assert.strictEqual((await call(b, 'GET', '/api/v1/server', { bearer: tok.body.secret })).status, 200);
        await new Promise(function (r) { setTimeout(r, 5); });
        h.dbDocs['user//alice'].passchange = -1; // reset without a new password
        h.users['user//alice'].passchange = -1;
        let r = await call(b, 'GET', '/api/v1/server', { bearer: tok.body.secret });
        assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error.code, 'token_revoked');
        assert.strictEqual((await call(c, 'GET', '/api/v1/server')).status, 401);
        const nb = await h.core.store.userstate.findOne({ _id: 'user//alice' });
        assert.ok(nb.nb > 0, 'not_before persisted');
        const d = await h.core.store.tokens.findOne({ _id: tok.body.token.id });
        assert.ok(d.revoked != null); assert.strictEqual(d.revoked_reason, 'credentials_changed');
    });
});

test('not_before: a password change by anyone ends earlier sessions and tokens; new logins work', async function () {
    await withServer({ users }, async function (h) {
        const c = h.client();
        await c.login('alice', users.alice.password);
        const tok = await c.post('/api/v1/auth/tokens', { json: { name: 'ro', scopes: ['read'] } });
        await new Promise(function (r) { setTimeout(r, 5); });
        h.dbDocs['user//alice'].hash = 'new-hash'; h.users['user//alice'].hash = 'new-hash'; // changed outside the API, passchange untouched
        h.core.notBefore.sweep(h.users); // the periodic sweep sees it first
        await new Promise(function (r) { setTimeout(r, 20); });
        const d = await h.core.store.tokens.findOne({ _id: tok.body.token.id });
        assert.strictEqual(d.revoked_reason, 'credentials_changed', 'tokens list as revoked');
        assert.strictEqual((await call(c, 'GET', '/api/v1/server')).status, 401);
        const c2 = h.client();
        assert.strictEqual((await c2.login('alice', users.alice.password)).status, 200);
        assert.strictEqual((await call(c2, 'GET', '/api/v1/server')).status, 200);
        const list = await call(c2, 'GET', '/api/v1/auth/tokens');
        assert.ok(list.body.items[0].revoked_at);
    });
});

test('2FA completion re-checks not_before and lock state', async function () {
    await withServer({ users }, async function (h) {
        const c = h.client();
        await c.login('bob', users.bob.password);
        await new Promise(function (r) { setTimeout(r, 5); });
        h.dbDocs['user//bob'].hash = 'changed';
        const r = await call(c, 'POST', '/api/v1/auth/2fa', { json: { code: '123456' } });
        assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error.code, 'no_pending_login');
        // Malformed codes feed MeshCentral's per-IP 2FA counter
        await c.login('bob', users.bob.password);
        await c.post('/api/v1/auth/2fa', { json: { code: 'abcd' } });
        assert.ok(h.badLogins.bad2fa >= 1);
    });
});

test('limiters: locked entries are never evicted; unknown names share one bucket', async function () {
    const l = new FailureLock(3, 60000, 60000, 5);
    for (let i = 0; i < 3; i++) l.fail('victim');
    assert.ok(l.lockedFor('victim') > 0);
    for (let i = 0; i < 1000; i++) l.fail('spray' + i);
    assert.ok(l.lockedFor('victim') > 0, 'still locked after spraying');
    assert.ok(l.map.size <= 5);
    const w = new WindowLimiter(1, 60000, 3);
    w.hit('a'); w.hit('a');
    for (let i = 0; i < 100; i++) w.hit('x' + i);
    assert.strictEqual(w.hit('a').allowed, false, 'an over-limit entry is not evicted');
    await withServer({ users }, async function (h) {
        const c = h.client();
        for (let i = 0; i < 10; i++) await c.login('alice', 'wrong');
        for (let i = 0; i < 50; i++) await c.login('nobody' + i, 'wrong');
        const r = await c.login('alice', users.alice.password);
        assert.strictEqual(r.status, 401, 'alice stays locked');
        assert.ok(h.core.limits.account.map.size <= 3, 'unknown names do not create entries: ' + h.core.limits.account.map.size);
    });
});

test('store files are created with mode 0600', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outband-store-'));
    try {
        const store = await openStore({ dir: dir });
        await store.settings.insert({ _id: 'x' });
        await store.settings.ds.compactDatafileAsync();
        store.close();
        for (const f of fs.readdirSync(dir).filter(function (f) { return f.startsWith('outband-'); })) {
            assert.strictEqual(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('forwarding headers: last hop only, from an explicitly configured proxy only', function () {
    const certs = { CommonName: 'outband.example.com' }, d = { id: '' };
    const req = function (peer, h) { return { socket: { remoteAddress: peer }, headers: h }; };
    const args = { port: 443, trustedproxy: ['192.0.2.1'] };
    const { fromTrustedProxy } = require('../../outband/util');
    const r1 = req('192.0.2.1', { host: 'internal', 'x-forwarded-host': 'evil.example.net, outband.example.com', 'x-forwarded-proto': 'http, https' });
    assert.ok(checkHost(r1, d, certs, args, fromTrustedProxy(args, r1)));
    assert.ok(isSecureRequest(args, r1));
    const r2 = req('192.0.2.1', { host: 'internal', 'x-forwarded-host': 'outband.example.com, evil.example.net', 'x-forwarded-proto': 'https, http' });
    assert.ok(!checkHost(r2, d, certs, args, fromTrustedProxy(args, r2)));
    assert.ok(!isSecureRequest(args, r2));
    const r3 = req('203.0.113.7', { host: 'internal', 'x-forwarded-host': 'outband.example.com', 'x-forwarded-proto': 'https' });
    assert.ok(!fromTrustedProxy(args, r3), 'not a configured proxy');
    assert.ok(!fromTrustedProxy({ tlsoffload: true }, r3), '"any peer" is not trusted for forwarding headers');
    assert.ok(fromTrustedProxy({ tlsoffload: '203.0.113.0/24' }, r3));
});

test('central scope check before idempotency; power rights before path details; profile names', async function () {
    await withServer({ users }, async function (h) {
        const c = h.client();
        await c.login('alice', users.alice.password);
        const tok = await c.post('/api/v1/auth/tokens', { json: { name: 'ro', scopes: ['read'] } });
        const b = h.client();
        let r = await call(b, 'POST', '/api/v1/devices/EXAMPLEnodeId0000/power', { bearer: tok.body.secret, csrf: false, json: { action: 'off' }, headers: { 'idempotency-key': 'retry-0001-example' } }); // test value, not a secret
        assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error.code, 'insufficient_scope');
        r = await call(b, 'POST', '/api/v1/devices/EXAMPLEnodeId0000/console/sol/ticket', { bearer: tok.body.secret, csrf: false });
        assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error.code, 'insufficient_scope');
        r = await call(c, 'POST', '/api/v1/auth/tokens', { json: { name: 'x', profile: 'constructor' } });
        assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error.details.field, 'profile');
        r = await call(c, 'POST', '/api/v1/auth/tokens', { json: { name: 'x', profile: '__proto__' } });
        assert.strictEqual(r.status, 400);
    });
    const env = { groupKind: 'agent', reachable: { amt: true }, allowed: function () { return false; } };
    assert.throws(function () { power.plan(env, 'off', null); }, function (e) { return (e.status == 403) && !('available_paths' in (e.details || {})); });
});

test('API off switch and multi-server setups answer 503', async function () {
    await withServer({ users, settings: { outbandapi: { enabled: false } } }, async function (h) {
        assert.strictEqual((await call(h.client(), 'GET', '/api/v1/session')).status, 503);
        assert.strictEqual((await call(h.client(), 'GET', '/api/v1/health')).status, 200);
    });
    await withServer({ users, parent: { multiServer: {} } }, async function (h) {
        assert.strictEqual((await call(h.client(), 'GET', '/api/v1/session')).status, 503);
    });
});

test('audit: find keeps the caller filter with a cursor; bad cursors are 400; retention purge at startup', async function () {
    await withServer({ users }, async function (h) {
        for (let i = 0; i < 5; i++) await h.core.audit.write({ action: 'outband.login', user: (i % 2) ? 'user//a' : 'user//b' });
        const q = { $or: [{ user: 'user//a' }] };
        const p1 = await h.core.audit.find(q, 1, null);
        const p2 = await h.core.audit.find(q, 5, p1.next);
        assert.ok(p1.items.concat(p2.items).every(function (d) { return d.user == 'user//a'; }));
        await assert.rejects(h.core.audit.find({}, 1, { t: 'x', i: {} }), function (e) { return e.status == 400; });
    });
    // Startup purge: an expired record is gone after create()
    const { Audit } = require('../../outband/audit');
    void Audit;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outband-purge-'));
    try {
        const store = await openStore({ dir: dir });
        await store.audit.insert({ _id: 'evt_old', time: Date.now() - 400 * 86400000, action: 'outband.login' });
        await store.audit.ds.compactDatafileAsync();
        store.close();
        const h = await start({ users, coreOptions: { inMemory: false, dir: dir } });
        try { assert.strictEqual((await h.core.store.audit.find({ _id: 'evt_old' })).length, 0); } finally { await h.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('erasure covers events about the user: token names dropped, owner pseudonymized', async function () {
    await withServer({ users }, async function (h) {
        const a = h.client(); await a.login('admin', users.admin.password);
        const c = h.client(); await c.login('alice', users.alice.password);
        const tok = await c.post('/api/v1/auth/tokens', { json: { name: 'alice-private-name', scopes: ['read'] } });
        await a.del('/api/v1/admin/tokens/' + tok.body.token.id);
        await h.core.eraseUser('user//alice');
        const all = await h.core.store.audit.find({});
        const s = JSON.stringify(all);
        assert.ok(!s.includes('alice-private-name'), 'token names dropped');
        assert.ok(!s.includes('"owner":"alice"'), 'owner pseudonymized');
        assert.ok(!s.includes('user//alice'), 'no user id left');
    });
});

test('login and 2FA request bodies never reach any log (debug, auth log, console)', async function () {
    const lines = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = function (...a) { lines.push(a.join(' ')); };
    try {
        await withServer({ users }, async function (h) {
            const c = h.client();
            await c.login('alice', users.alice.password);
            await c.login('alice', 'Wrong-Secret-Value-9');
            await c.login('evil\nname\u001b[31m', 'x');
            await c.login('bob', users.bob.password);
            await c.post('/api/v1/auth/2fa', { json: { code: '654321' } });
            await c.post('/api/v1/auth/2fa', { json: { code: '123456' } });
            const all = lines.concat(h.debugLines).join('\n');
            for (const s of [users.alice.password, 'Wrong-Secret-Value-9', users.bob.password, '654321', '123456']) assert.ok(!all.includes(s), 'leaked ' + s);
            assert.ok(!/evil\nname/.test(all) && !all.includes('\u001b'), 'control characters stripped');
        });
    } finally { Object.assign(console, orig); }
});

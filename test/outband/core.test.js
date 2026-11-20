/**
 * In-process tests of the Outband security core, with contract checks.
 * Run: node --test test/outband/
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { start, ORIGIN, FULL } = require('./harness');
const { check } = require('./contract');

const ADMIN = { password: 'Admin-Pass-1', siteadmin: FULL };
const ALICE = { password: 'Alice-Pass-1' };
const BOB2FA = { password: 'Bob-Pass-1', otpsecret: 'SECRET', testcode: '123456' };

async function withServer(opts, fn) {
    const h = await start(opts);
    try { await fn(h); } finally { await h.close(); }
}

/** Request + contract check. */
async function call(c, method, path, opts) {
    const fn = { GET: 'get', POST: 'post', PUT: 'put', DELETE: 'del' }[method];
    const r = await c[fn](path, opts);
    check(method, path, r);
    return r;
}

const users = { admin: ADMIN, alice: ALICE, bob: BOB2FA, locked: { password: 'Locked-Pass-1', siteadmin: 32 } };

test('health needs no auth and answers ok', async function () {
    await withServer({ users }, async function (h) {
        const r = await call(h.client(), 'GET', '/api/v1/health');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body, { status: 'ok' });
        assert.strictEqual(r.headers['cache-control'], 'no-store');
    });
});

test('no-auth modes and a missing server name answer 503 (health still works)', async function () {
    await withServer({ users, args: { nousers: true } }, async function (h) {
        const c = h.client();
        assert.strictEqual((await call(c, 'GET', '/api/v1/session')).status, 503);
        assert.strictEqual((await call(c, 'GET', '/api/v1/health')).status, 200);
    });
    await withServer({ users, args: { user: 'admin' } }, async function (h) {
        assert.strictEqual((await call(h.client(), 'POST', '/api/v1/auth/login', { json: { username: 'admin', password: 'x' } })).status, 503);
    });
    await withServer({ users, cn: 'un-configured' }, async function (h) {
        const r = await call(h.client(), 'GET', '/api/v1/server');
        assert.strictEqual(r.status, 503);
        assert.strictEqual(r.body.error.code, 'unavailable');
    });
});

test('Host must be a configured name with the expected port (421)', async function () {
    await withServer({ users }, async function (h) {
        const c = h.client();
        assert.strictEqual((await call(c, 'GET', '/api/v1/session', { headers: { host: 'evil.example.net' } })).status, 421);
        assert.strictEqual((await call(c, 'GET', '/api/v1/session', { headers: { host: 'outband.example.com:8443' } })).status, 421);
        assert.strictEqual((await call(c, 'GET', '/api/v1/session', { headers: { host: 'outband.example.com:443' } })).status, 200);
        assert.strictEqual((await call(c, 'GET', '/api/v1/session', { headers: { host: 'OUTBAND.example.com' } })).status, 200);
    });
    await withServer({ users, domain: { allowedorigin: ['https://ui.example.org'] } }, async function (h) {
        assert.strictEqual((await call(h.client(), 'GET', '/api/v1/session', { headers: { host: 'ui.example.org' } })).status, 200);
    });
});

test('CSRF: login needs X-Outband and a matching Origin; OPTIONS refused; no CORS', async function () {
    await withServer({ users }, async function (h) {
        const c = h.client();
        const body = { username: 'alice', password: ALICE.password };
        let r = await call(c, 'POST', '/api/v1/auth/login', { json: body, csrf: false, headers: { origin: ORIGIN } });
        assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error.code, 'csrf_failed');
        r = await call(c, 'POST', '/api/v1/auth/login', { json: body, csrf: false, headers: { 'x-outband': '1' } });
        assert.strictEqual(r.status, 403);
        r = await call(c, 'POST', '/api/v1/auth/login', { json: body, csrf: false, headers: { 'x-outband': '1', origin: 'http://outband.example.com' } });
        assert.strictEqual(r.status, 403, 'http origins never match');
        r = await call(c, 'POST', '/api/v1/auth/login', { json: body, csrf: false, headers: { 'x-outband': '1', origin: 'https://outband.example.com.evil.example.net' } });
        assert.strictEqual(r.status, 403);
        const o = await c.request('OPTIONS', '/api/v1/auth/login', { headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } });
        assert.strictEqual(o.status, 403);
        assert.strictEqual(o.headers['access-control-allow-origin'], undefined);
        r = await call(c, 'POST', '/api/v1/auth/login', { json: body });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers['access-control-allow-origin'], undefined);
        // Cookie-authenticated non-GET without CSRF headers
        r = await call(c, 'POST', '/api/v1/auth/tokens', { json: { name: 'x', scopes: ['read'] }, csrf: false });
        assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error.code, 'csrf_failed');
        // Audited (aggregated)
        const docs = await h.core.store.audit.find({ action: 'outband.csrf' });
        assert.ok(docs.length >= 1);
    });
});

test('bodies must be application/json (415) and unknown fields are refused (400)', async function () {
    await withServer({ users }, async function (h) {
        const c = h.client();
        let r = await call(c, 'POST', '/api/v1/auth/login', { raw: 'username=alice&password=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        assert.strictEqual(r.status, 415);
        r = await call(c, 'POST', '/api/v1/auth/login', { json: { username: 'alice', password: 'x', extra: 1 } });
        assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error.details.field, 'extra');
        r = await call(c, 'POST', '/api/v1/auth/login', { raw: '{bad', headers: { 'content-type': 'application/json' } });
        assert.strictEqual(r.status, 400);
    });
});

test('login: every refusal is the same 401; success creates a session with a record', async function () {
    await withServer({ users }, async function (h) {
        const c = h.client();
        const bad = [['alice', 'wrong'], ['nobody', 'x'], ['locked', 'Locked-Pass-1'], ['~t:abc', 'x']];
        for (const [u, p] of bad) {
            const r = await call(c, 'POST', '/api/v1/auth/login', { json: { username: u, password: p } });
            assert.strictEqual(r.status, 401, u);
            assert.deepStrictEqual({ code: r.body.error.code, message: r.body.error.message }, { code: 'invalid_credentials', message: 'Invalid username or password' });
            assert.ok(!('details' in r.body.error));
        }
        const r = await call(c, 'POST', '/api/v1/auth/login', { json: { username: 'alice', password: ALICE.password } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.user.id, 'alice');
        assert.ok(c.jar.xid, 'session cookie set');
        const s = await call(c, 'GET', '/api/v1/session');
        assert.strictEqual(s.body.authenticated, true);
        assert.strictEqual(s.body.auth_method, 'cookie');
        assert.deepStrictEqual(s.body.scopes, ['read', 'power_on', 'power_off', 'console', 'identity', 'audit']);
        assert.strictEqual(h.core.sessions.records.size, 1);
        const rec = [...h.core.sessions.records.values()][0];
        assert.ok(rec.la != null, 'login handler wrote last_auth');
        assert.strictEqual(rec.la2, null);
    });
});

test('login-token sessions get 401 on every request', async function () {
    await withServer({ users }, async function (h) {
        const c = h.client();
        await c.login('alice', ALICE.password);
        assert.strictEqual((await call(c, 'GET', '/api/v1/server')).status, 200);
        const r = await call(c, 'GET', '/api/v1/server', { headers: { 'x-test-logintoken': '1' } });
        assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error.code, 'unauthenticated');
        const s2 = await call(c, 'GET', '/api/v1/session', { headers: { 'x-test-logintoken': '1' } });
        assert.strictEqual(s2.body.authenticated, false);
    });
});

test('session rules: no record, lifetime, logout revocation, no session id', async function () {
    await withServer({ users }, async function (h) {
        const c = h.client();
        await c.login('alice', ALICE.password);
        assert.strictEqual((await call(c, 'GET', '/api/v1/server')).status, 200);
        // Lifetime: age the record past the limit
        const rec = [...h.core.sessions.records.values()][0];
        rec.ia -= h.core.config.sessionLifetimeMs + 1000;
        let r = await call(c, 'GET', '/api/v1/server');
        assert.strictEqual(r.status, 401);
        // New login, then logout -> revocation list, also checked by auth cookies
        await c.login('alice', ALICE.password);
        const rec2 = [...h.core.sessions.records.values()].find(function (x) { return (Date.now() - x.ia) < 60000; });
        assert.strictEqual(h.core.checkAuthCookie({ userid: rec2.u, x: rec2.x }), true);
        const saved = Object.assign({}, c.jar);
        r = await call(c, 'POST', '/api/v1/auth/logout');
        assert.strictEqual(r.status, 204);
        assert.strictEqual(h.core.checkAuthCookie({ userid: rec2.u, x: rec2.x }), false);
        assert.strictEqual(h.core.checkAuthCookie({ ruserid: rec2.u, x: rec2.x }), false);
        assert.ok(h.webserver.destroyedSessions[rec2.u + '/' + rec2.x] != null);
        const rev = await h.core.store.revocations.find({});
        assert.ok(rev.some(function (d) { return d.k == rec2.u + '/' + rec2.x; }), 'revocation persisted');
        // Sending the old cookie again does not work
        c.jar = saved;
        r = await call(c, 'GET', '/api/v1/server');
        assert.strictEqual(r.status, 401);
        // A session without a session id is never upgraded
        assert.strictEqual(h.core.sessionValid({ userid: 'user//alice' }), false);
        assert.strictEqual(h.core.sessionValid({}), true);
    });
});

test('deleted or locked users and password changes end sessions', async function () {
    await withServer({ users }, async function (h) {
        const c = h.client();
        await c.login('alice', ALICE.password);
        h.dbDocs['user//alice'].siteadmin = 32; // LOCKED
        let r = await call(c, 'GET', '/api/v1/server');
        assert.strictEqual(r.status, 401);
        h.dbDocs['user//alice'].siteadmin = 0;
        await c.login('alice', ALICE.password);
        for (const u of [h.dbDocs['user//alice'], h.users['user//alice']]) { u.passchange = Math.floor(Date.now() / 1000) + 5; } // MeshCentral updates both copies
        r = await call(c, 'GET', '/api/v1/server');
        assert.strictEqual(r.status, 401);
        for (const u of [h.dbDocs['user//alice'], h.users['user//alice']]) { delete u.passchange; }
        await c.login('alice', ALICE.password);
        delete h.dbDocs['user//alice'];
        r = await call(c, 'GET', '/api/v1/server');
        assert.strictEqual(r.status, 401);
    });
});

test('2FA: pending login authenticates nothing; 5 wrong codes discard it; correct code logs in', async function () {
    await withServer({ users }, async function (h) {
        const c = h.client();
        let r = await call(c, 'POST', '/api/v1/auth/login', { json: { username: 'bob', password: BOB2FA.password } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.authenticated, false);
        assert.strictEqual(r.body.twofa.required, true);
        assert.deepStrictEqual(r.body.twofa.methods, ['otp']);
        // The cookie holds only an opaque id: no userid, nothing else
        const raw = JSON.parse(Buffer.from(c.jar.xid, 'base64').toString('utf8'));
        assert.deepStrictEqual(Object.keys(raw).sort(), ['obp']);
        assert.deepStrictEqual(Object.keys(raw.obp).sort(), ['e', 'i']);
        assert.ok(!JSON.stringify(raw).includes('bob'));
        assert.ok(!JSON.stringify(raw).includes(BOB2FA.password));
        // Nothing is authenticated
        assert.strictEqual((await call(c, 'GET', '/api/v1/server')).status, 401);
        const s = await call(c, 'GET', '/api/v1/session');
        assert.strictEqual(s.body.authenticated, false);
        assert.strictEqual(s.body.twofa.required, true);
        assert.strictEqual((await call(c, 'GET', '/api/v1/auth/tokens')).status, 401);
        // Wrong codes
        for (let i = 0; i < 5; i++) {
            r = await call(c, 'POST', '/api/v1/auth/2fa', { json: { code: '000000' } });
            assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error.code, 'invalid_code');
        }
        r = await call(c, 'POST', '/api/v1/auth/2fa', { json: { code: '123456' } });
        assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error.code, 'no_pending_login');
        // Fresh pending login, correct code
        await c.login('bob', BOB2FA.password);
        r = await call(c, 'POST', '/api/v1/auth/2fa', { json: { code: '123456', method: 'otp' } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.authenticated, true);
        const rec = [...h.core.sessions.records.values()].find(function (x) { return x.u == 'user//bob'; });
        assert.ok(rec.la != null && rec.la2 != null);
        assert.strictEqual((await call(c, 'GET', '/api/v1/server')).status, 200);
    });
});

test('2FA: per-user limit across pending logins, then refusal', async function () {
    await withServer({ users }, async function (h) {
        const c = h.client();
        for (let round = 0; round < 2; round++) {
            await c.login('bob', BOB2FA.password);
            for (let i = 0; i < 5; i++) { await c.post('/api/v1/auth/2fa', { json: { code: '000000' } }); }
        }
        await c.login('bob', BOB2FA.password);
        const r = await call(c, 'POST', '/api/v1/auth/2fa', { json: { code: '123456' } });
        assert.strictEqual(r.status, 429);
        assert.ok(r.headers['retry-after']);
    });
});

test('per-account login lock after 10 failures, same 401, not affected by IP', async function () {
    await withServer({ users }, async function (h) {
        const c = h.client();
        for (let i = 0; i < 10; i++) { await c.post('/api/v1/auth/login', { json: { username: 'alice', password: 'wrong' }, headers: { 'x-test-ip': '198.51.100.' + i } }); }
        const r = await call(c, 'POST', '/api/v1/auth/login', { json: { username: 'alice', password: ALICE.password }, headers: { 'x-test-ip': '203.0.113.9' } });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.body.error.code, 'invalid_credentials');
        // Other accounts are fine
        assert.strictEqual((await c.login('admin', ADMIN.password)).status, 200);
        // MeshCentral's per-IP ban answers 429 JSON
        h.badLogins.blocked = true;
        const b = await call(c, 'POST', '/api/v1/auth/login', { json: { username: 'admin', password: ADMIN.password } });
        assert.strictEqual(b.status, 429);
    });
});

async function stepUpSession(h, name, password) {
    const c = h.client();
    const r = await c.login(name, password);
    assert.strictEqual(r.status, 200);
    return c;
}

test('tokens: create, use per request, scopes, revoke, expiry, allowed_ips, TLS', async function () {
    await withServer({ users }, async function (h) {
        const c = await stepUpSession(h, 'alice', ALICE.password);
        let r = await call(c, 'POST', '/api/v1/auth/tokens', { json: { name: 'auto', profile: 'device_power', expires_in_days: 90, allowed_ips: ['127.0.0.0/8'] } });
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        const secret = r.body.secret, id = r.body.token.id;
        assert.match(secret, /^obt_[A-Za-z0-9_-]{43}$/);
        assert.deepStrictEqual(r.body.token.scopes, ['read', 'power_on', 'power_off']);
        // Only the hash is stored
        const stored = await h.core.store.tokens.findOne({ _id: id });
        assert.ok(!JSON.stringify(stored).includes(secret.substring(4)));
        const b = h.client();
        // TLS required
        r = await call(b, 'GET', '/api/v1/server', { bearer: secret, tls: false });
        assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error.code, 'https_required');
        r = await call(b, 'GET', '/api/v1/session', { bearer: secret });
        assert.strictEqual(r.body.auth_method, 'token');
        assert.strictEqual(r.body.user.email, undefined, 'no identity scope: email left out');
        assert.strictEqual(r.body.user.siteadmin, undefined);
        assert.strictEqual((await call(b, 'GET', '/api/v1/server', { bearer: secret })).status, 200);
        // Session-only endpoints
        r = await call(b, 'GET', '/api/v1/auth/tokens', { bearer: secret });
        assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error.details.reason, 'session_required');
        // Bearer wins over a cookie
        r = await call(c, 'GET', '/api/v1/session', { bearer: secret });
        assert.strictEqual(r.body.auth_method, 'token');
        // allowed_ips
        r = await call(b, 'GET', '/api/v1/server', { bearer: secret, headers: { 'x-test-ip': '192.0.2.5' } });
        assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error.code, 'ip_not_allowed');
        // Locked owner: checked per request
        h.dbDocs['user//alice'].siteadmin = 32;
        r = await call(b, 'GET', '/api/v1/server', { bearer: secret });
        assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error.code, 'token_revoked');
        h.dbDocs['user//alice'].siteadmin = 0;
        assert.strictEqual((await call(b, 'GET', '/api/v1/server', { bearer: secret })).status, 200);
        // Password change revokes tokens
        for (const u of [h.dbDocs['user//alice'], h.users['user//alice']]) { u.passchange = Math.floor(Date.now() / 1000) + 5; } // MeshCentral updates both copies
        r = await call(b, 'GET', '/api/v1/server', { bearer: secret });
        assert.strictEqual(r.body.error.code, 'token_revoked');
        for (const u of [h.dbDocs['user//alice'], h.users['user//alice']]) { delete u.passchange; }
        assert.strictEqual((await call(c, 'GET', '/api/v1/server')).status, 401, 'the password change also ended the session');
        await c.login('alice', ALICE.password);
        // List, revoke
        r = await call(c, 'GET', '/api/v1/auth/tokens');
        assert.strictEqual(r.body.items.length, 1);
        r = await call(c, 'DELETE', '/api/v1/auth/tokens/' + id);
        assert.strictEqual(r.status, 204);
        r = await call(b, 'GET', '/api/v1/server', { bearer: secret });
        assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error.code, 'token_revoked');
        const ended = await h.core.store.audit.find({ action: 'outband.token.use_ended' });
        assert.ok(ended.length >= 1);
        // Expiry
        r = await call(c, 'POST', '/api/v1/auth/tokens', { json: { name: 'ro', scopes: ['read'] } });
        const ro = r.body.secret;
        await h.core.store.tokens.update({ _id: r.body.token.id }, { $set: { expires: Date.now() - 1 } });
        r = await call(b, 'GET', '/api/v1/server', { bearer: ro });
        assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error.code, 'token_expired');
        // Unknown token
        r = await call(b, 'GET', '/api/v1/server', { bearer: 'obt_' + 'A'.repeat(43) });
        assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error.code, 'unauthenticated');
    });
});

test('tokens: lifetime caps, console needs groups, step-up, limits', async function () {
    await withServer({ users }, async function (h) {
        const c = await stepUpSession(h, 'alice', ALICE.password);
        let r = await call(c, 'POST', '/api/v1/auth/tokens', { json: { name: 'a', scopes: ['audit'], expires_in_days: 120 } });
        assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error.details.field, 'expires_in_days');
        r = await call(c, 'POST', '/api/v1/auth/tokens', { json: { name: 'a', scopes: ['read', 'identity'], expires_in_days: 365 } });
        assert.strictEqual(r.status, 201);
        r = await call(c, 'POST', '/api/v1/auth/tokens', { json: { name: 'a', scopes: ['console'], expires_in_days: 30 } });
        assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error.details.field, 'groups');
        r = await call(c, 'POST', '/api/v1/auth/tokens', { json: { name: 'a', scopes: ['read'], profile: 'device_power' } });
        assert.strictEqual(r.status, 400);
        // Step-up: age last_auth
        for (const rec of h.core.sessions.records.values()) rec.la = Date.now() - 16 * 60000;
        r = await call(c, 'POST', '/api/v1/auth/tokens', { json: { name: 'p', scopes: ['power_on'] } });
        assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error.code, 'reauth_required');
        r = await call(c, 'POST', '/api/v1/auth/tokens', { json: { name: 'au', scopes: ['audit'] } });
        assert.strictEqual(r.status, 401, 'audit needs step-up');
        r = await call(c, 'POST', '/api/v1/auth/tokens', { json: { name: 'ro', scopes: ['read'] } });
        assert.strictEqual(r.status, 201, 'read does not need step-up');
        // Reauth restores step-up on the same session
        const before = c.jar.xid;
        r = await call(c, 'POST', '/api/v1/auth/reauth', { json: { password: ALICE.password } });
        assert.strictEqual(r.status, 204);
        assert.strictEqual(c.jar.xid, before, 'no new session');
        r = await call(c, 'POST', '/api/v1/auth/tokens', { json: { name: 'p', scopes: ['power_on'] } });
        assert.strictEqual(r.status, 201);
    });
});

test('reauth: wrong password 401, mixed body 400, 2FA two steps, counts towards the account lock', async function () {
    await withServer({ users }, async function (h) {
        const c = h.client();
        await c.login('bob', BOB2FA.password);
        await c.post('/api/v1/auth/2fa', { json: { code: '123456' } });
        let r = await call(c, 'POST', '/api/v1/auth/reauth', { json: { password: BOB2FA.password, code: '1' } });
        assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error.details.field, 'code');
        r = await call(c, 'POST', '/api/v1/auth/reauth', { json: { code: '123456' } });
        assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error.code, 'reauth_required');
        r = await call(c, 'POST', '/api/v1/auth/reauth', { json: { password: 'wrong' } });
        assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error.code, 'invalid_credentials');
        assert.strictEqual((await call(c, 'GET', '/api/v1/server')).status, 200, 'a wrong password never ends the session');
        r = await call(c, 'POST', '/api/v1/auth/reauth', { json: { password: BOB2FA.password } });
        assert.strictEqual(r.status, 200); assert.strictEqual(r.body.twofa.required, true);
        r = await call(c, 'POST', '/api/v1/auth/reauth', { json: { code: '999999' } });
        assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error.code, 'invalid_code');
        r = await call(c, 'POST', '/api/v1/auth/reauth', { json: { code: '123456' } });
        assert.strictEqual(r.status, 204);
        // Bearer cannot reauth
        const ok = await c.post('/api/v1/auth/tokens', { json: { name: 'ro', scopes: ['read'] } });
        r = await call(h.client(), 'POST', '/api/v1/auth/reauth', { bearer: ok.body.secret, json: { password: 'x' }, csrf: false });
        assert.strictEqual(r.status, 403);
        // Account lock shared with login
        for (let i = 0; i < 10; i++) await c.post('/api/v1/auth/reauth', { json: { password: 'wrong' } });
        r = await call(h.client(), 'POST', '/api/v1/auth/login', { json: { username: 'bob', password: BOB2FA.password } });
        assert.strictEqual(r.status, 401);
    });
});

test('kill switch: bearer_disabled at once, before token lookup; admin only with step-up; audited', async function () {
    await withServer({ users }, async function (h) {
        const a = await stepUpSession(h, 'admin', ADMIN.password);
        const t = await a.post('/api/v1/auth/tokens', { json: { name: 'ro', scopes: ['read'] } });
        const secret = t.body.secret;
        const b = h.client();
        assert.strictEqual((await call(b, 'GET', '/api/v1/server', { bearer: secret })).status, 200);
        // Non-admin
        const u = await stepUpSession(h, 'alice', ALICE.password);
        let r = await call(u, 'PUT', '/api/v1/admin/settings', { json: { bearer: false } });
        assert.strictEqual(r.status, 403);
        // Bearer cannot change it
        r = await call(b, 'PUT', '/api/v1/admin/settings', { bearer: secret, json: { bearer: false }, csrf: false });
        assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error.details.reason, 'session_required');
        r = await call(a, 'GET', '/api/v1/admin/settings');
        assert.deepStrictEqual([r.body.bearer, r.body.bearer_source], [true, 'config']);
        r = await call(a, 'PUT', '/api/v1/admin/settings', { json: { bearer: false } });
        assert.strictEqual(r.status, 200); assert.strictEqual(r.body.bearer, false); assert.strictEqual(r.body.bearer_source, 'runtime');
        const before = (await h.core.store.tokens.findOne({ _id: t.body.token.id })).last_used;
        r = await call(b, 'GET', '/api/v1/server', { bearer: secret });
        assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error.code, 'bearer_disabled');
        r = await call(b, 'GET', '/api/v1/server', { bearer: 'obt_' + 'B'.repeat(43) });
        assert.strictEqual(r.body.error.code, 'bearer_disabled', 'answered before lookup');
        assert.strictEqual((await h.core.store.tokens.findOne({ _id: t.body.token.id })).last_used, before);
        // Sessions still work; feature flag shows it
        r = await call(a, 'GET', '/api/v1/server');
        assert.strictEqual(r.body.features.api_tokens, false);
        r = await call(a, 'PUT', '/api/v1/admin/settings', { json: { bearer: true } });
        assert.strictEqual((await call(b, 'GET', '/api/v1/server', { bearer: secret })).status, 200);
        const ev = await h.core.store.audit.find({ action: 'outband.settings.bearer' });
        assert.strictEqual(ev.length, 2, 'both directions audited');
        // Step-up needed
        for (const rec of h.core.sessions.records.values()) rec.la = Date.now() - 16 * 60000;
        r = await call(a, 'PUT', '/api/v1/admin/settings', { json: { bearer: false } });
        assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error.code, 'reauth_required');
    });
});

test('admin tokens: list all, revoke any; non-admins refused', async function () {
    await withServer({ users }, async function (h) {
        const u = await stepUpSession(h, 'alice', ALICE.password);
        const t = await u.post('/api/v1/auth/tokens', { json: { name: 'mine', scopes: ['read'] } });
        const a = await stepUpSession(h, 'admin', ADMIN.password);
        let r = await call(a, 'GET', '/api/v1/admin/tokens?user=alice');
        assert.strictEqual(r.body.items.length, 1);
        assert.strictEqual(r.body.items[0].owner.id, 'alice');
        assert.ok(!JSON.stringify(r.body).includes('"h"'));
        r = await call(a, 'GET', '/api/v1/admin/tokens?prefix=' + t.body.token.prefix);
        assert.strictEqual(r.body.items.length, 1);
        assert.strictEqual((await call(u, 'GET', '/api/v1/admin/tokens')).status, 403);
        assert.strictEqual((await call(u, 'DELETE', '/api/v1/admin/tokens/' + t.body.token.id)).status, 403);
        r = await call(a, 'DELETE', '/api/v1/admin/tokens/' + t.body.token.id);
        assert.strictEqual(r.status, 204);
        r = await call(h.client(), 'GET', '/api/v1/server', { bearer: t.body.secret });
        assert.strictEqual(r.body.error.code, 'token_revoked');
        r = await call(a, 'GET', '/api/v1/admin/tokens?include_revoked=true');
        assert.ok(r.body.items[0].revoked_at);
        r = await call(a, 'DELETE', '/api/v1/admin/tokens/tok_doesnotexist');
        assert.strictEqual(r.status, 404);
    });
});

test('invalid bearer limiter: 30 in 10 minutes then 429, separate from logins', async function () {
    await withServer({ users }, async function (h) {
        const b = h.client();
        for (let i = 0; i < 30; i++) await b.get('/api/v1/server', { bearer: 'obt_' + 'C'.repeat(43) });
        const r = await call(b, 'GET', '/api/v1/server', { bearer: 'obt_' + 'C'.repeat(43) });
        assert.strictEqual(r.status, 429); assert.ok(r.headers['retry-after']);
        assert.strictEqual((await h.client().login('alice', ALICE.password)).status, 200);
    });
});

test('per-credential limit and RateLimit headers; none on auth endpoints', async function () {
    await withServer({ users, settings: { outbandapi: { ratelimits: { requestsperminute: 3 } } } }, async function (h) {
        const c = h.client();
        const l = await c.login('alice', ALICE.password);
        assert.strictEqual(l.headers['ratelimit-limit'], undefined);
        let r;
        for (let i = 0; i < 3; i++) { r = await call(c, 'GET', '/api/v1/server'); assert.strictEqual(r.status, 200); }
        assert.strictEqual(r.headers['ratelimit-limit'], '3');
        assert.strictEqual(r.headers['ratelimit-remaining'], '0');
        r = await call(c, 'GET', '/api/v1/server');
        assert.strictEqual(r.status, 429); assert.ok(r.headers['retry-after']);
    });
});

test('credentials in the URL are refused and redacted from debug logs', async function () {
    await withServer({ users }, async function (h) {
        const c = h.client();
        const r = await call(c, 'GET', '/api/v1/stream?access_token=obt_' + 'D'.repeat(43));
        assert.strictEqual(r.status, 400);
        // The debug wrapper redacts query secrets, Authorization, Cookie and Sec-WebSocket-Protocol
        h.parent.debug('httpheaders', 'GET', '/x?token=abc&ticket=def&n=1', { authorization: 'Bearer obt_' + 'E'.repeat(43), cookie: 'xid=secret', 'sec-websocket-protocol': 'outband.console.v1, outband.ticket.zzz', host: 'h' });
        h.parent.debug('web', 'Login with Bearer obt_' + 'F'.repeat(43));
        const log = h.debugLines.join('\n');
        assert.ok(!log.includes('abc') && !log.includes('def'), log);
        assert.ok(!log.includes('E'.repeat(43)) && !log.includes('F'.repeat(43)));
        assert.ok(!log.includes('xid=secret') && !log.includes('zzz'));
        assert.ok(log.includes('[redacted]'));
    });
});

test('login and 2fa bodies and createToken secrets never reach the debug log', async function () {
    await withServer({ users }, async function (h) {
        const c = h.client();
        await c.login('alice', ALICE.password);
        await c.login('bob', BOB2FA.password);
        await c.post('/api/v1/auth/2fa', { json: { code: '123456' } });
        const t = await c.post('/api/v1/auth/tokens', { json: { name: 'x', scopes: ['read'] } });
        const log = h.debugLines.join('\n');
        for (const s of [ALICE.password, BOB2FA.password, '123456', t.body.secret]) assert.ok(!log.includes(s), 'leaked ' + s);
    });
});

test('power and console endpoints are typed 501 stubs behind real auth', async function () {
    await withServer({ users }, async function (h) {
        const anon = h.client();
        assert.strictEqual((await call(anon, 'GET', '/api/v1/devices')).status, 401);
        const c = await stepUpSession(h, 'alice', ALICE.password);
        const r = await call(c, 'POST', '/api/v1/devices/EXAMPLEnodeId0000/power', { json: { action: 'off' } });
        assert.strictEqual(r.status, 501); assert.strictEqual(r.body.error.code, 'not_implemented');
        assert.strictEqual((await call(c, 'GET', '/api/v1/devices?limit=999')).status, 400);
        assert.strictEqual((await call(c, 'POST', '/api/v1/devices/EXAMPLEnodeId0000/power', { json: { action: 'off', bogus: 1 } })).status, 400);
    });
});

test('console tickets: single use, bound, cancelled by logout', async function () {
    await withServer({ users }, async function (h) {
        h.core.setResources(Object.assign({}, h.core.resources, {
            consoleTarget: async function (ctx, deviceId) { ctx.requireScope('console'); return { deviceId: deviceId, groupId: 'mesh//EXAMPLEgroup' }; }
        }));
        const c = await stepUpSession(h, 'alice', ALICE.password);
        const dev = 'EXAMPLEnodeId00000000';
        const r = await call(c, 'POST', '/api/v1/devices/' + dev + '/console/sol/ticket');
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        assert.ok(!r.body.url.includes('ticket'));
        const ticket = r.body.protocols[1].substring('outband.ticket.'.length);
        assert.ok(h.core.tickets.consume(ticket, 'other', 'sol') == null, 'bound to the device');
        const r2 = await c.post('/api/v1/devices/' + dev + '/console/sol/ticket');
        const t2 = r2.body.protocols[1].substring('outband.ticket.'.length);
        const b = h.core.tickets.consume(t2, dev, 'sol');
        assert.ok(b && b.cookie === true);
        assert.strictEqual(h.core.tickets.consume(t2, dev, 'sol'), null, 'single use');
        const r3 = await c.post('/api/v1/devices/' + dev + '/console/sol/ticket');
        const t3 = r3.body.protocols[1].substring('outband.ticket.'.length);
        await c.post('/api/v1/auth/logout');
        assert.strictEqual(h.core.tickets.consume(t3, dev, 'sol'), null, 'logout cancels');
        // A token without console gets 403 insufficient_scope (audited)
        const c2 = await stepUpSession(h, 'alice', ALICE.password);
        const tok = await c2.post('/api/v1/auth/tokens', { json: { name: 'ro', scopes: ['read'] } });
        const d = await call(h.client(), 'POST', '/api/v1/devices/' + dev + '/console/sol/ticket', { bearer: tok.body.secret, csrf: false });
        assert.strictEqual(d.status, 403); assert.strictEqual(d.body.error.code, 'insufficient_scope');
    });
});

test('erasure: tokens and sessions removed, audit events pseudonymized with truncated source_ip', async function () {
    await withServer({ users }, async function (h) {
        const c = await stepUpSession(h, 'alice', ALICE.password);
        await c.post('/api/v1/auth/tokens', { json: { name: 'x', scopes: ['read'] } });
        await h.core.audit.write({ action: 'outband.login', user: 'user//alice', userName: 'alice', ip: '198.51.100.77' });
        await h.core.eraseUser('user//alice');
        assert.strictEqual((await h.core.store.tokens.find({ owner: 'user//alice' })).length, 0);
        assert.strictEqual([...h.core.sessions.records.values()].filter(function (r) { return r.u == 'user//alice'; }).length, 0);
        const ev = await h.core.store.audit.find({ user_name: 'deleted user' });
        assert.ok(ev.length >= 1);
        assert.ok(ev.every(function (e) { return e.user.startsWith('u_') && (e.source_ip == null || e.source_ip.endsWith('/24') || e.source_ip.endsWith('/48')); }));
        assert.ok(ev.some(function (e) { return e.source_ip == '198.51.100.0/24'; }));
    });
});

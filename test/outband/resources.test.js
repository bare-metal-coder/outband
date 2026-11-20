/**
 * Resource endpoints: groups, devices, events, stream. In-process, with the
 * fake MeshCentral of harness.js, and every response checked against the spec.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { start, NAME, FULL } = require('./harness');
const { check, checkSchema } = require('./contract');

const A = 'GroupAlpha0001', B = 'GroupBeta00002';
const MA = 'mesh//' + A, MB = 'mesh//' + B;
const N1 = 'NodeServer01', N2 = 'NodeAnother02', N3 = 'NodeAmtBox003';
const FN1 = 'node//' + N1, FN2 = 'node//' + N2, FN3 = 'node//' + N3;
const LIMITEVENTS = 0x2000;

const USERS = {
    admin: { password: 'Admin-Pass-1', siteadmin: FULL },
    alice: { password: 'Alice-Pass-1', links: { [MA]: { rights: FULL }, [MB]: { rights: FULL } } },
    bob: { password: 'Bob-Pass-1', links: { [MA]: { rights: 0x40 } } },
    carol: { password: 'Carol-Pass-1', links: { [MA]: { rights: 0x8 | 0x40 | LIMITEVENTS } } },
    dave: { password: 'Dave-Pass-1', siteadmin: 0x800 },
    eve: { password: 'Eve-Pass-1' },
    frank: { password: 'Frank-Pass-1', links: { [MA]: { rights: 0x40000 } } },
    gina: { password: 'Gina-Pass-1', siteadmin: FULL, links: { [MA]: { rights: FULL }, [MB]: { rights: FULL } } }
};

async function world(extra) {
    const h = await start(Object.assign({ users: USERS, settings: { outbandapi: { ratelimits: { eventsperminute: 100000 } } } }, extra || {}));
    h.meshes[MA] = { _id: MA, name: 'Alpha', desc: 'First group', mtype: 2, domain: '' };
    h.meshes[MB] = { _id: MB, name: 'Beta', desc: '', mtype: 1, domain: '' };
    const node = function (id, name, mesh, more) { h.dbDocs[id] = Object.assign({ _id: id, type: 'node', name: name, host: name + '.example.com', meshid: mesh, domain: '' }, more || {}); };
    node(FN1, 'server-01', MA, { ip: '192.0.2.10', osdesc: 'Ubuntu 24.04 LTS', intelamt: { state: 2, ver: '16.1.25' }, agent: { ver: 1, id: 6 }, desc: 'Rack 1', tags: ['lab'] });
    node(FN2, 'Another-02', MA, { ip: '192.0.2.11' });
    node(FN3, 'amt-box', MB, { ip: '192.0.2.12', intelamt: { state: 2, ver: '12.0.1' } });
    h.dbDocs['lc' + FN2] = { _id: 'lc' + FN2, type: 'lastconnect', time: Date.parse('2026-01-01T10:00:00Z'), addr: '192.0.2.11:4433' };
    h.dbDocs['si' + FN1] = { _id: 'si' + FN1, hardware: { identifiers: { bios_serial: 'SN-EXAMPLE-0001', product_name: 'Example 1U', board_vendor: 'Example Corp', cpu_name: 'Example CPU' }, windows: { memory: [{ Capacity: 8589934592 }] } } };
    h.parent.connectivityByNode[FN1] = { connectivity: 1 | 4, powerState: 1, meshid: MA };
    h.parent.connectivityByNode[FN3] = { connectivity: 4, powerState: 8, meshid: MB };
    return h;
}
async function withWorld(fn, extra) { const h = await world(extra); try { await fn(h); } finally { await h.close(); } }

async function call(c, method, path, opts) { const r = await c[{ GET: 'get', POST: 'post', DELETE: 'del', PUT: 'put' }[method]](path, opts); check(method, path, r); return r; }
async function session(h, name) { const c = h.client(); const r = await c.login(name, USERS[name].password); assert.strictEqual(r.status, 200, JSON.stringify(r.body)); return c; }
async function token(h, name, body) {
    const c = await session(h, name);
    const r = await c.post('/api/v1/auth/tokens', { json: Object.assign({ name: 'tok-' + Math.random().toString(36).slice(2, 8) }, body) });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return { secret: r.body.secret, id: r.body.token.id, owner: c };
}
const bearer = function (t) { return { bearer: t.secret, csrf: false }; };
const tick = function () { return new Promise(function (r) { setTimeout(r, 30); }); };
function mcEvent(h, o) {
    const e = Object.assign({ _id: 'EV' + (h.mcEvents.length + 1).toString().padStart(4, '0'), etype: 'node', action: 'changenode', time: new Date().toISOString(), domain: '', msg: 'FREE-TEXT-MARKER 198.51.100.77', ids: ['*'] }, o);
    h.mcEvents.push(e);
    return e;
}

// ---- stream client -------------------------------------------------------

function openStream(h, o) {
    o = o || {};
    return new Promise(function (resolve, reject) {
        const headers = Object.assign({ host: NAME }, o.headers || {});
        if (o.bearer) { headers.authorization = 'Bearer ' + o.bearer.secret; headers['x-forwarded-proto'] = 'https'; }
        else if (o.client) headers.cookie = o.client.cookieHeader();
        const req = http.request({ host: '127.0.0.1', port: h.port, path: '/api/v1/stream' + (o.query || ''), headers: headers, agent: false }, function (res) {
            const s = { status: res.statusCode, headers: res.headers, raw: '', messages: [], blocks: [], ended: false, body: null, close: function () { req.destroy(); } };
            res.setEncoding('utf8');
            let buf = '';
            res.on('data', function (d) {
                s.raw += d; buf += d;
                let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const block = buf.substring(0, i); buf = buf.substring(i + 2);
                    const f = {};
                    for (const line of block.split('\n')) { const k = line.indexOf(':'); if (k > 0) f[line.substring(0, k)] = line.substring(k + 2); }
                    s.blocks.push(f);
                    if (f.data) { const m = JSON.parse(f.data); m._id = f.id; m._event = f.event; s.messages.push(m); }
                }
            });
            res.on('end', function () { s.ended = true; try { s.body = JSON.parse(s.raw); } catch (ex) { } });
            res.on('close', function () { s.ended = true; });
            s.of = function (type) { return s.messages.filter(function (m) { return m.type == type; }); };
            s.waitFor = async function (pred, ms) {
                const until = Date.now() + (ms || 5000);
                while (Date.now() < until) { if (pred(s)) return true; await new Promise(function (r) { setTimeout(r, 20); }); }
                return pred(s);
            };
            resolve(s);
        });
        req.on('error', function (e) { if (!o.ignoreErrors) reject(e); });
        req.end();
    });
}
const open = async function (h, o) { const s = await openStream(h, o); assert.strictEqual(s.status, 200, s.raw); await s.waitFor(function (x) { return x.of('ready').length > 0; }); return s; };

// ---- groups --------------------------------------------------------------

test('groups: visibility, rights, paging, 404 for what is not visible', async function () {
    await withWorld(async function (h) {
        const alice = await session(h, 'alice');
        let r = await call(alice, 'GET', '/api/v1/groups');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.items.map(function (g) { return g.name; }), ['Alpha', 'Beta']);
        assert.strictEqual(r.body.items[0].device_count, 2);
        assert.deepStrictEqual(r.body.items[0].rights, { mask: FULL, names: ['admin'] });
        assert.strictEqual(r.body.items[1].kind, 'amt');
        r = await call(alice, 'GET', '/api/v1/groups?limit=1');
        assert.strictEqual(r.body.items.length, 1); assert.ok(r.body.next_cursor);
        const r2 = await call(alice, 'GET', '/api/v1/groups?limit=1&cursor=' + r.body.next_cursor);
        assert.strictEqual(r2.body.items[0].name, 'Beta'); assert.strictEqual(r2.body.next_cursor, null);
        assert.strictEqual((await call(alice, 'GET', '/api/v1/groups?cursor=bogus')).status, 400);

        const bob = await session(h, 'bob');
        r = await call(bob, 'GET', '/api/v1/groups');
        assert.deepStrictEqual(r.body.items.map(function (g) { return g.name; }), ['Alpha']);
        assert.deepStrictEqual(r.body.items[0].rights.names, ['wakedevice']);
        assert.strictEqual((await call(bob, 'GET', '/api/v1/groups/' + B)).status, 404);
        assert.strictEqual((await call(bob, 'GET', '/api/v1/groups/' + A)).status, 200);
        assert.strictEqual((await call(bob, 'GET', '/api/v1/groups/NoSuchGroup1')).status, 404);
        assert.deepStrictEqual((await call(await session(h, 'eve'), 'GET', '/api/v1/groups')).body.items, []);
    });
});

test('groups and devices: a token groups restriction narrows visibility', async function () {
    await withWorld(async function (h) {
        const t = await token(h, 'alice', { scopes: ['read'], groups: [A] });
        let r = await call(h.client(), 'GET', '/api/v1/groups', bearer(t));
        assert.deepStrictEqual(r.body.items.map(function (g) { return g.id; }), [A]);
        assert.strictEqual((await call(h.client(), 'GET', '/api/v1/groups/' + B, bearer(t))).status, 404);
        r = await call(h.client(), 'GET', '/api/v1/devices', bearer(t));
        assert.deepStrictEqual(r.body.items.map(function (d) { return d.id; }).sort(), [N1, N2].sort());
        assert.strictEqual((await call(h.client(), 'GET', '/api/v1/devices/' + N3, bearer(t))).status, 404);
        assert.strictEqual((await call(h.client(), 'GET', '/api/v1/devices?group=' + B, bearer(t))).body.items.length, 0);
    });
});

// ---- devices -------------------------------------------------------------

test('devices: list, filters, paging, sort by name', async function () {
    await withWorld(async function (h) {
        const alice = await session(h, 'alice');
        let r = await call(alice, 'GET', '/api/v1/devices');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.items.map(function (d) { return d.name; }), ['amt-box', 'Another-02', 'server-01']);
        const s1 = r.body.items.find(function (d) { return d.id == N1; });
        assert.strictEqual(s1.online, true);
        assert.deepStrictEqual(s1.group, { id: A, name: 'Alpha' });
        assert.deepStrictEqual(s1.power.state, 'on');
        assert.deepStrictEqual(s1.connectivity, { agent: true, amt_cira: false, amt_local: true, relay: false, mqtt: false });
        assert.deepStrictEqual(s1.amt, { state: 'provisioned', version: '16.1.25', reachable: true });
        assert.deepStrictEqual(s1.ips, ['192.0.2.10']);
        assert.strictEqual(s1.links.ui, '/devices/' + N1);
        const offline = r.body.items.find(function (d) { return d.id == N2; });
        assert.strictEqual(offline.online, false); assert.strictEqual(offline.last_seen, '2026-01-01T10:00:00.000Z');
        assert.strictEqual(offline.power.state, 'unknown'); assert.strictEqual(offline.amt.state, 'none');
        const ids = async function (q) { return (await call(alice, 'GET', '/api/v1/devices' + q)).body.items.map(function (d) { return d.id; }).sort(); };
        assert.deepStrictEqual(await ids('?group=' + A), [N1, N2].sort());
        assert.deepStrictEqual(await ids('?status=online'), [N1]);
        assert.deepStrictEqual(await ids('?status=offline'), [N2, N3].sort());
        assert.deepStrictEqual(await ids('?status=amt'), [N1, N3].sort());
        assert.deepStrictEqual(await ids('?q=ANOTHER'), [N2]);
        assert.deepStrictEqual(await ids('?q=amt-box.example'), [N3]);
        // paging
        r = await call(alice, 'GET', '/api/v1/devices?limit=2');
        assert.strictEqual(r.body.items.length, 2); assert.ok(r.body.next_cursor);
        const p2 = await call(alice, 'GET', '/api/v1/devices?limit=2&cursor=' + r.body.next_cursor);
        assert.deepStrictEqual(p2.body.items.map(function (d) { return d.name; }), ['server-01']); assert.strictEqual(p2.body.next_cursor, null);
        assert.strictEqual((await call(alice, 'GET', '/api/v1/devices?status=bogus')).status, 400);
        assert.deepStrictEqual((await call(await session(h, 'eve'), 'GET', '/api/v1/devices')).body.items, []);
    });
});

test('devices: detail, hardware and agent info; 404 is identical and audited', async function () {
    await withWorld(async function (h) {
        const alice = await session(h, 'alice');
        const r = await call(alice, 'GET', '/api/v1/devices/' + N1);
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.rights, { mask: FULL, names: ['admin'] });
        assert.strictEqual(r.body.description, 'Rack 1'); assert.deepStrictEqual(r.body.tags, ['lab']);
        assert.deepStrictEqual(r.body.hardware, { manufacturer: 'Example Corp', model: 'Example 1U', serial: 'SN-EXAMPLE-0001', cpu: 'Example CPU', memory_mb: 8192 });
        assert.strictEqual(r.body.agent.version, '1'); assert.strictEqual(r.body.agent.type, 6);
        const missing = await call(alice, 'GET', '/api/v1/devices/NoSuchNode001');
        const hidden = await call(await session(h, 'eve'), 'GET', '/api/v1/devices/' + N1);
        assert.strictEqual(missing.status, 404); assert.strictEqual(hidden.status, 404);
        assert.deepStrictEqual(Object.assign({}, missing.body.error, { request_id: 0 }), Object.assign({}, hidden.body.error, { request_id: 0 }));
        await tick();
        const au = await h.core.store.audit.find({ action: 'outband.not_found' });
        assert.ok(au.length >= 2, 'both 404s are audited');
        assert.ok(au.some(function (a) { return a.user == 'user//eve' && a.device_id == FN1; }));
        // events of an invisible device are a 404 too
        assert.strictEqual((await call(await session(h, 'eve'), 'GET', '/api/v1/devices/' + N1 + '/events')).status, 404);
        assert.strictEqual((await call(alice, 'GET', '/api/v1/devices/bad%20id')).status, 400);
    });
});

test('devices: capabilities follow scope, rights and reachability (nothing is dispatched)', async function () {
    await withWorld(async function (h) {
        const caps = async function (c, o) { return (await call(c, 'GET', '/api/v1/devices/' + N1, o)).body.capabilities; };
        let c = await caps(await session(h, 'alice'));
        assert.deepStrictEqual(c.power_via.off, ['agent']);
        assert.ok(c.power.includes('off') && c.power.includes('on') && c.power.includes('cycle'));
        assert.deepStrictEqual(c.power_via.cycle, ['amt']);
        assert.deepStrictEqual(c.console, ['sol']);
        // wake-up right only: on/wake, no off
        c = await caps(await session(h, 'bob'));
        assert.ok(c.power.includes('on') && !c.power.includes('off'));
        // reset/off right only: no on
        c = await caps(await session(h, 'frank'));
        assert.ok(c.power.includes('off') && !c.power.includes('on'));
        // a token without power scopes has no power actions; device_power has no console
        const ro = await token(h, 'alice', { scopes: ['read'] });
        c = await caps(h.client(), bearer(ro));
        assert.deepStrictEqual(c.power, []); assert.deepStrictEqual(c.console, []);
        const dp = await token(h, 'alice', { profile: 'device_power' });
        c = await caps(h.client(), bearer(dp));
        assert.ok(c.power.includes('off')); assert.deepStrictEqual(c.console, []);
        // offline agent: the default off has no path; power_paths may still list others
        h.parent.connectivityByNode[FN1].connectivity = 4;
        c = await caps(await session(h, 'alice'));
        assert.ok(!c.power.includes('off'));
        assert.ok(!h.events.some(function (e) { return /power|wake/i.test(String(e.action)); }), 'nothing dispatched');
    });
});

test('privacy: ips and serial only for sessions and tokens with console', async function () {
    await withWorld(async function (h) {
        const leaks = function (b) { const t = JSON.stringify(b); return t.includes('192.0.2.10') || t.includes('SN-EXAMPLE-0001') || ('ips' in b) || (b.hardware && ('serial' in b.hardware)); };
        const sess = await call(await session(h, 'alice'), 'GET', '/api/v1/devices/' + N1);
        assert.ok(sess.body.ips && sess.body.hardware.serial);
        for (const body of [{ profile: 'device_power' }, { scopes: ['read'] }, { scopes: ['read', 'audit'] }, { scopes: ['read', 'identity'] }]) {
            const t = await token(h, 'alice', body);
            assert.ok(!leaks((await call(h.client(), 'GET', '/api/v1/devices/' + N1, bearer(t))).body), JSON.stringify(body));
            const list = await call(h.client(), 'GET', '/api/v1/devices', bearer(t));
            assert.ok(!JSON.stringify(list.body).includes('192.0.2.1'), 'list: ' + JSON.stringify(body));
        }
        const con = await token(h, 'alice', { scopes: ['read', 'console'], groups: [A] });
        const r = await call(h.client(), 'GET', '/api/v1/devices/' + N1, bearer(con));
        assert.deepStrictEqual(r.body.ips, ['192.0.2.10']); assert.strictEqual(r.body.hardware.serial, 'SN-EXAMPLE-0001');
    });
});

// ---- events --------------------------------------------------------------

test('events: visibility by rights, LIMITEVENTS, ALLEVENTS and group-restricted tokens', async function () {
    await withWorld(async function (h) {
        mcEvent(h, { nodeid: FN1, meshid: MA, userid: 'user//alice', username: 'alice', ids: [FN1, MA, '*'], time: '2026-01-01T12:00:00Z' });
        mcEvent(h, { nodeid: FN3, meshid: MB, userid: 'user//alice', username: 'alice', ids: [FN3, MB, '*'], time: '2026-01-01T12:01:00Z' });
        mcEvent(h, { etype: 'user', action: 'login', userid: 'user//carol', username: 'carol', ip: '198.51.100.9', ids: ['user//carol', '*'], time: '2026-01-01T12:02:00Z' });
        mcEvent(h, { etype: 'server', action: 'servertimeout', ids: ['*'], time: '2026-01-01T12:03:00Z' });
        mcEvent(h, { nodeid: FN1, meshid: MA, userid: 'user//carol', username: 'carol', ids: [FN1, MA, '*'], time: '2026-01-01T12:04:00Z' });
        const actions = async function (c, path, o) { const r = await call(c, 'GET', path + '?audit=false', o); assert.strictEqual(r.status, 200); return r.body.items.map(function (e) { return e.type + ':' + (e.group_id || '-') + ':' + (e.user ? e.user.name || 'p' : '-'); }); };
        // alice: both groups, not carol's login, not server events
        const al = await actions(await session(h, 'alice'), '/api/v1/events');
        assert.strictEqual(al.length, 3, al.join());
        // bob: group A only
        assert.strictEqual((await actions(await session(h, 'bob'), '/api/v1/events')).length, 2);
        // carol (LIMITEVENTS): only her own events (her login + her node event)
        assert.strictEqual((await actions(await session(h, 'carol'), '/api/v1/events')).length, 2);
        // eve sees nothing
        assert.strictEqual((await actions(await session(h, 'eve'), '/api/v1/events')).length, 0);
        // full admin and ALLEVENTS see the whole domain, incl. server events
        assert.strictEqual((await actions(await session(h, 'admin'), '/api/v1/events')).length, 5);
        assert.strictEqual((await actions(await session(h, 'dave'), '/api/v1/events')).length, 5);
        // a group-restricted token never gets the domain-wide view (even for a full admin)
        const tr = await token(h, 'gina', { scopes: ['read'], groups: [A] });
        const rest = await actions(h.client(), '/api/v1/events', bearer(tr));
        assert.strictEqual(rest.length, 2, 'only group A events of an admin with a restriction: ' + rest.join());
        const unr = await token(h, 'gina', { scopes: ['read'] });
        assert.strictEqual((await actions(h.client(), '/api/v1/events', bearer(unr))).length, 5);
        // device events: same rules
        const dev = await call(await session(h, 'carol'), 'GET', '/api/v1/devices/' + N1 + '/events');
        assert.strictEqual(dev.body.items.length, 1);
        assert.strictEqual((await call(await session(h, 'alice'), 'GET', '/api/v1/devices/' + N1 + '/events')).body.items.length, 2);
    });
});

test('events: free text and identities never pass through; filters and paging', async function () {
    await withWorld(async function (h) {
        for (let i = 0; i < 5; i++) mcEvent(h, { nodeid: FN1, meshid: MA, userid: 'user//alice', username: 'alice', ids: [FN1, MA, '*'], time: new Date(Date.parse('2026-01-01T12:00:00Z') + i * 1000).toISOString(), ip: '198.51.100.9' });
        mcEvent(h, { etype: 'mesh', action: 'meshchange', meshid: MA, userid: 'user//alice', username: 'alice', ids: [MA, '*'], time: '2026-01-01T13:00:00Z' });
        await h.core.audit.write({ domain: '', type: 'node', action: 'outband.power', user: 'user//alice', userName: 'alice', tokenId: 'tok_EXAMPLEid01', tokenName: 'private-token-label', deviceId: FN1, groupId: MA, actionId: 'act_1', ip: '198.51.100.5', params: { power_action: 'off', path: 'agent' } });
        const ro = await token(h, 'alice', { scopes: ['read'] });
        const r = await call(h.client(), 'GET', '/api/v1/events?limit=200', bearer(ro));
        const text = JSON.stringify(r.body);
        for (const s of ['FREE-TEXT-MARKER', '198.51.100', 'private-token-label', 'tok_EXAMPLEid01', '"alice"', 'user//alice']) assert.ok(!text.includes(s), 'leaked ' + s);
        const pw = r.body.items.find(function (e) { return e.action == 'outband.power'; });
        assert.strictEqual(pw.message, 'Power action "off" dispatched through agent');
        assert.strictEqual(pw.user.redacted, true); assert.match(pw.user.id, /^u_/); assert.match(pw.token_id, /^t_/);
        assert.strictEqual(pw.device_id, N1); assert.strictEqual(pw.group_id, A); assert.strictEqual(pw.outcome, 'success');
        // an audit-scoped token sees names; source_ip only for an unrestricted full admin
        const au = await token(h, 'alice', { scopes: ['read', 'audit'] });
        const ra = (await call(h.client(), 'GET', '/api/v1/events?audit=true', bearer(au))).body.items.find(function (e) { return e.action == 'outband.power'; });
        assert.strictEqual(ra.user.name, 'alice'); assert.strictEqual(ra.token_name, 'private-token-label'); assert.strictEqual(ra.source_ip, null);
        const ad = await token(h, 'admin', { scopes: ['read', 'audit'] });
        assert.strictEqual((await call(h.client(), 'GET', '/api/v1/events?audit=true', bearer(ad))).body.items.find(function (e) { return e.action == 'outband.power'; }).source_ip, '198.51.100.5');
        const adr = await token(h, 'gina', { scopes: ['read', 'audit'], groups: [A] });
        assert.ok((await call(h.client(), 'GET', '/api/v1/events?audit=true', bearer(adr))).body.items.every(function (e) { return e.source_ip === null; }));
        const sess = await session(h, 'admin');
        assert.strictEqual((await call(sess, 'GET', '/api/v1/events?audit=true')).body.items.find(function (e) { return e.action == 'outband.power'; }).source_ip, '198.51.100.5');
        // generic message for an event without a template
        const generic = (await call(sess, 'GET', '/api/v1/events?type=mesh')).body.items[0];
        assert.strictEqual(generic.message, 'Device group changed');
        // filters
        const alice = await session(h, 'alice');
        assert.strictEqual((await call(alice, 'GET', '/api/v1/events?type=mesh')).body.items.length, 1);
        assert.strictEqual((await call(alice, 'GET', '/api/v1/events?group=' + B)).body.items.length, 0);
        assert.strictEqual((await call(alice, 'GET', '/api/v1/events?device=' + N1 + '&audit=true')).body.items.length, 1);
        assert.strictEqual((await call(alice, 'GET', '/api/v1/events?device=' + N1 + '&since=2026-01-01T12:00:02Z&until=2026-01-01T12:00:04Z&audit=false')).body.items.length, 2);
        // paging walks every event exactly once, newest first
        const seen = []; let cur = null, pages = 0;
        do {
            const p = await call(alice, 'GET', '/api/v1/events?limit=2' + (cur ? '&cursor=' + cur : ''));
            for (const e of p.body.items) seen.push(e.id);
            cur = p.body.next_cursor; pages++;
        } while (cur && pages < 20);
        const everything = (await call(alice, 'GET', '/api/v1/events?limit=200')).body.items;
        assert.ok(everything.length >= 7); assert.strictEqual(new Set(seen).size, seen.length);
        assert.deepStrictEqual(seen, everything.map(function (e) { return e.id; }), 'pages add up to the full list, in order');
        const t = everything.map(function (e) { return e.time; });
        assert.deepStrictEqual(t, t.slice().sort().reverse());
        assert.strictEqual((await call(alice, 'GET', '/api/v1/events?since=nope')).status, 400);
    });
});

// ---- stream --------------------------------------------------------------

test('stream: envelope, retry hint, ready, device.power / device.updated from MeshCentral state changes', async function () {
    await withWorld(async function (h) {
        const alice = await session(h, 'alice');
        const s = await open(h, { client: alice });
        check('GET', '/api/v1/stream', { status: s.status, headers: s.headers, text: '' });
        assert.match(s.headers['content-type'], /^text\/event-stream/);
        assert.strictEqual(s.blocks[0].retry, '5000');
        assert.strictEqual(s.messages[0].type, 'ready'); assert.ok(!isNaN(Date.parse(s.messages[0].data.server_time)));
        // the power state changes in MeshCentral
        h.parent.connectivityByNode[FN1].powerState = 8;
        h.dispatch({ action: 'nodeconnect', meshid: MA, nodeid: FN1, domain: '', conn: 5, pwr: 8, nolog: 1 });
        await s.waitFor(function (x) { return x.of('device.power').length > 0 && x.of('device.updated').length > 0; });
        const p = s.of('device.power')[0];
        assert.strictEqual(p.data.id, N1); assert.strictEqual(p.data.power.state, 'off'); assert.ok(p.data.power.since);
        assert.strictEqual(s.of('device.updated')[0].data.power.state, 'off');
        assert.strictEqual(s.of('device.updated')[0].data.id, N1);
        for (const m of s.messages) { checkSchema('StreamMessage', { type: m.type, data: m.data }); assert.strictEqual(m._event, m.type); }
        assert.ok(s.messages.filter(function (m) { return m._id; }).every(function (m) { return /^\d+$/.test(m._id); }));
        // the same state again: no second power message
        h.dispatch({ action: 'nodeconnect', meshid: MA, nodeid: FN1, domain: '', conn: 5, pwr: 8, nolog: 1 });
        await tick(); await tick();
        assert.strictEqual(s.of('device.power').length, 1);
        // device removed
        h.dispatch({ action: 'removenode', meshid: MA, nodeid: FN1, domain: '' });
        await s.waitFor(function (x) { return x.of('device.removed').length > 0; });
        assert.strictEqual(s.of('device.removed')[0].data.id, N1);
        s.close();
    });
});

test('stream: types filter, unknown names ignored, control messages always sent', async function () {
    await withWorld(async function (h) {
        const alice = await session(h, 'alice');
        const s = await open(h, { client: alice, query: '?types=device.power,made.up.type,,resync' });
        h.dispatch({ action: 'nodeconnect', meshid: MA, nodeid: FN3, domain: '', conn: 4, pwr: 1, nolog: 1 });
        h.dispatch({ action: 'nodeconnect', meshid: MA, nodeid: FN1, domain: '', conn: 5, pwr: 8, nolog: 1 });
        await s.waitFor(function (x) { return x.of('device.power').length >= 1; });
        await tick();
        assert.deepStrictEqual(s.messages.map(function (m) { return m.type; }).filter(function (t) { return t != 'ready'; }).every(function (t) { return t == 'device.power'; }), true);
        assert.strictEqual(s.of('device.updated').length, 0);
        assert.strictEqual(s.of('ready').length, 1);
        // only unknown names: only control messages
        const s2 = await open(h, { client: alice, query: '?types=nothing.like.this' });
        h.dispatch({ action: 'nodeconnect', meshid: MA, nodeid: FN1, domain: '', conn: 5, pwr: 1, nolog: 1 });
        await tick(); await tick();
        assert.deepStrictEqual(s2.messages.map(function (m) { return m.type; }), ['ready']);
        // revocation still reports on a filtered stream
        s.close(); s2.close();
        const t = await token(h, 'alice', { scopes: ['read'] });
        const s3 = await open(h, { bearer: t, query: '?types=resync' });
        await (await session(h, 'alice')).del('/api/v1/auth/tokens/' + t.id);
        assert.ok(await s3.waitFor(function (x) { return x.of('closed').length > 0; }));
    });
});

test('stream: group restriction, rights and identities apply to every message', async function () {
    await withWorld(async function (h) {
        const tA = await token(h, 'gina', { scopes: ['read'], groups: [A] });
        const sA = await open(h, { bearer: tA });
        const alice = await session(h, 'alice');
        const sAdmin = await open(h, { client: await session(h, 'admin') });
        const eve = await open(h, { client: await session(h, 'eve') });
        h.dispatch({ action: 'nodeconnect', meshid: MB, nodeid: FN3, domain: '', conn: 4, pwr: 1, nolog: 1 });
        h.dispatch({ action: 'login', etype: 'user', userid: 'user//alice', username: 'alice', domain: '', ip: '198.51.100.9', msg: 'FREE-TEXT-MARKER' });
        h.dispatch({ action: 'changenode', etype: 'node', meshid: MA, nodeid: FN1, userid: 'user//alice', username: 'alice', domain: '', msg: 'FREE-TEXT-MARKER' });
        await h.core.audit.write({ domain: '', type: 'node', action: 'outband.power', user: 'user//alice', userName: 'alice', tokenId: 'tok_EXAMPLEid02', tokenName: 'private-token-label', deviceId: FN3, groupId: MB, ip: '198.51.100.5', params: { power_action: 'off', path: 'amt' } });
        await h.core.audit.write({ domain: '', type: 'node', action: 'outband.power', user: 'user//alice', userName: 'alice', tokenId: 'tok_EXAMPLEid02', tokenName: 'private-token-label', deviceId: FN1, groupId: MA, ip: '198.51.100.5', params: { power_action: 'on', path: 'amt' } });
        await sAdmin.waitFor(function (x) { return x.of('event.created').length >= 4; });
        await sA.waitFor(function (x) { return x.of('event.created').length >= 2 && x.of('device.updated').length >= 1; });
        await new Promise(function (r) { setTimeout(r, 400); });
        // the group-restricted admin token: group A only, no domain-wide events, no identities, no source_ip
        assert.strictEqual(sA.of('device.updated').length, 1); assert.strictEqual(sA.of('device.updated')[0].data.id, N1);
        assert.deepStrictEqual(sA.of('event.created').map(function (m) { return m.data.action; }).sort(), ['changenode', 'outband.power']);
        const txt = JSON.stringify(sA.messages);
        for (const x of ['FREE-TEXT-MARKER', '198.51.100', 'private-token-label', 'tok_EXAMPLEid02', 'user//alice']) assert.ok(!txt.includes(x), 'leaked ' + x);
        assert.ok(!txt.includes('"ips"'));
        // the admin session sees everything, with names and source_ip
        assert.ok(sAdmin.of('event.created').some(function (m) { return m.data.source_ip == '198.51.100.5' && m.data.user.name == 'alice'; }));
        // eve sees no device message and no event
        assert.strictEqual(eve.messages.filter(function (m) { return m.type != 'ready'; }).length, 0);
        for (const s of [sA, sAdmin, eve]) s.close();
    });
});

test('stream: resume with Last-Event-ID uses current visibility; unknown ids get resync', async function () {
    await withWorld(async function (h) {
        const alice = await session(h, 'alice');
        const s = await open(h, { client: alice });
        h.dispatch({ action: 'changenode', etype: 'node', meshid: MA, nodeid: FN1, userid: 'user//alice', username: 'alice', domain: '' });
        await s.waitFor(function (x) { return x.of('event.created').length > 0; });
        const last = s.messages.filter(function (m) { return m._id; }).pop()._id;
        s.close();
        h.dispatch({ action: 'nodeconnect', meshid: MA, nodeid: FN1, domain: '', conn: 5, pwr: 8, nolog: 1 });
        h.dispatch({ action: 'changenode', etype: 'node', meshid: MB, nodeid: FN3, userid: 'user//alice', username: 'alice', domain: '' });
        h.dispatch({ action: 'changenode', etype: 'node', meshid: MA, nodeid: FN2, userid: 'user//alice', username: 'alice', domain: '' });
        // header and query parameter both work; the header wins
        const r = await open(h, { client: alice, headers: { 'last-event-id': last }, query: '?last_event_id=1' });
        await r.waitFor(function (x) { return x.of('event.created').length >= 2 && x.of('device.updated').length >= 1; });
        await new Promise(function (r2) { setTimeout(r2, 400); });
        assert.strictEqual(r.of('resync').length, 0);
        assert.strictEqual(r.of('device.power').length, 1);
        assert.ok(r.of('device.updated').length >= 1);
        assert.strictEqual(r.of('event.created').length, 2);
        // nothing is sent twice
        assert.ok(r.messages.filter(function (m) { return m._id; }).every(function (m) { return BigInt(m._id) > BigInt(last); }));
        r.close();
        // rights changed in between: the resumed stream shows only what is visible now
        delete h.dbDocs['user//bob'].links['mesh//' + A];
        h.dbDocs['user//bob'].links[MB] = { rights: FULL };
        const bob = await session(h, 'bob');
        const rb = await open(h, { client: bob, headers: { 'last-event-id': last } });
        await rb.waitFor(function (x) { return x.of('event.created').length >= 1; });
        await new Promise(function (r2) { setTimeout(r2, 400); });
        assert.deepStrictEqual(rb.of('event.created').map(function (m) { return m.data.group_id; }).filter(Boolean), [B]);
        assert.ok(rb.of('device.updated').every(function (m) { return m.data.id == N3; }));
        rb.close();
        // unknown, malformed, and future ids: resync, then live messages continue
        for (const id of ['1', 'garbage', '99999999999999999', String(Number(last) + 100000)]) {
            const x = await open(h, { client: alice, headers: { 'last-event-id': id } });
            assert.ok(await x.waitFor(function (y) { return y.of('resync').length == 1; }), 'resync for ' + id);
            assert.strictEqual(x.of('event.created').length, 0);
            x.close();
        }
        // the group-restricted token resumed never shows other groups
        const tA = await token(h, 'gina', { scopes: ['read'], groups: [A] });
        const rt = await open(h, { bearer: tA, headers: { 'last-event-id': last } });
        await rt.waitFor(function (x) { return x.of('event.created').length >= 1; });
        await new Promise(function (r2) { setTimeout(r2, 400); });
        assert.ok(rt.of('event.created').every(function (m) { return (m.data.group_id == A) || (m.data.group_id == null); }));
        assert.ok(rt.of('device.updated').every(function (m) { return m.data.id != N3; }));
        rt.close();
    });
});

test('stream: revocation ends it with the right reason within 5 seconds', async function () {
    await withWorld(async function (h) {
        const reasonOf = function (s) { return s.of('closed')[0].data.reason; };
        const ended = async function (s, ms) { const t0 = Date.now(); assert.ok(await s.waitFor(function (x) { return x.of('closed').length > 0 && x.ended; }, ms || 5000), 'closed within 5 s'); assert.ok(Date.now() - t0 < 5000); };
        // token revoked (bus event, at once)
        let t = await token(h, 'alice', { scopes: ['read'] });
        let s = await open(h, { bearer: t });
        await (await session(h, 'alice')).del('/api/v1/auth/tokens/' + t.id);
        await ended(s); assert.strictEqual(reasonOf(s), 'revoked');
        // token expired: no event, the periodic check catches it
        t = await token(h, 'alice', { scopes: ['read'] });
        s = await open(h, { bearer: t });
        await h.core.store.tokens.update({ _id: t.id }, { $set: { expires: Date.now() - 1000 } });
        await ended(s); assert.strictEqual(reasonOf(s), 'expired');
        // logout
        const c = await session(h, 'alice');
        s = await open(h, { client: c });
        await c.post('/api/v1/auth/logout');
        await ended(s); assert.strictEqual(reasonOf(s), 'logout');
        // user locked: the periodic check
        const c2 = await session(h, 'alice');
        s = await open(h, { client: c2 });
        h.dbDocs['user//alice'].siteadmin = 32;
        await ended(s); assert.strictEqual(reasonOf(s), "locked");
        h.dbDocs['user//alice'].siteadmin = 0;
        // kill switch: retryable reason `disabled`
        t = await token(h, 'alice', { scopes: ['read'] });
        s = await open(h, { bearer: t });
        const adm = await session(h, 'admin');
        const r = await adm.put('/api/v1/admin/settings', { json: { bearer: false } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        await ended(s); assert.strictEqual(reasonOf(s), 'disabled');
        await adm.put('/api/v1/admin/settings', { json: { bearer: true } });
        // rights change: reconnect to see the new rights
        const c3 = await session(h, 'bob');
        s = await open(h, { client: c3 });
        h.dbDocs['user//bob'].links[MB] = { rights: 0x40 };
        await ended(s); assert.strictEqual(reasonOf(s), 'rights');
        // a revoked credential cannot open a new stream
        await (await session(h, 'alice')).del('/api/v1/auth/tokens/' + t.id);
        const again = await openStream(h, { bearer: t });
        assert.strictEqual(again.status, 401);
    });
});

test('stream: the per-credential slot is released on every way a stream ends', async function () {
    await withWorld(async function (h) {
        const c = await session(h, 'alice');
        const streams = [];
        for (let i = 0; i < 5; i++) streams.push(await open(h, { client: c }));
        const sixth = await openStream(h, { client: c });
        assert.strictEqual(sixth.status, 429);
        await sixth.waitFor(function (x) { return x.ended; });
        check('GET', '/api/v1/stream', { status: sixth.status, headers: sixth.headers, text: sixth.raw, body: sixth.body });
        assert.ok(sixth.headers['retry-after']);
        // client disconnect frees a slot
        streams.pop().close();
        let x;
        for (let i = 0; i < 100; i++) { x = await openStream(h, { client: c, ignoreErrors: true }); if (x.status == 200) break; x.close(); await tick(); }
        assert.strictEqual(x.status, 200); streams.push(x);
        // logout ends all five at once (closed), and frees every slot
        await c.post('/api/v1/auth/logout');
        for (const s of streams) assert.ok(await s.waitFor(function (y) { return y.of('closed').length > 0; }));
        const c2 = await session(h, 'alice');
        const fresh = [];
        for (let i = 0; i < 5; i++) fresh.push(await open(h, { client: c2 }));
        // server shutdown ends streams with a retryable reason, and frees slots
        h.core.bus.emit('shutdown');
        for (const s of fresh) { assert.ok(await s.waitFor(function (y) { return y.of('closed').length > 0; })); assert.strictEqual(s.of('closed')[0].data.reason, 'shutdown'); }
        assert.strictEqual(h.core.limits.streams.map.size, 0, 'no slot is left');
        // a token-limited credential has its own count
        const t = await token(h, 'alice', { scopes: ['read'] });
        const ts = await open(h, { bearer: t });
        ts.close();
        await tick(); await tick();
        assert.strictEqual(h.core.limits.streams.map.size, 0);
    });
});

test('stream: errors answer JSON, not a stream', async function () {
    await withWorld(async function (h) {
        const anon = await openStream(h, {});
        await anon.waitFor(function (x) { return x.ended; });
        assert.strictEqual(anon.status, 401);
        const c = await session(h, 'alice');
        const bad = await openStream(h, { client: c, query: '?token=x' });
        assert.strictEqual(bad.status, 400);
        const long = await openStream(h, { client: c, headers: { 'last-event-id': 'x'.repeat(100) } });
        assert.strictEqual(long.status, 400);
    });
});

// ---- event reads: bounded work, continuation cursor, limiter -----------------

function countReads(h) {
    const c = { calls: 0, rows: 0, limits: [] };
    const orig = h.webserver.db.GetEventsWithLimit;
    h.webserver.db.GetEventsWithLimit = function (ids, domain, limit, filter, cb) { c.calls++; c.limits.push(limit); return orig(ids, domain, limit, filter, function (e, docs) { c.rows += docs.length; cb(e, docs); }); };
    return c;
}
function manyEvents(h, n, every) {
    for (let i = 0; i < n; i++) mcEvent(h, { etype: (i % every == 0) ? 'mesh' : 'node', action: 'changenode', meshid: MA, nodeid: FN1, ids: [FN1, MA, '*'], time: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 1000).toISOString(), _id: 'EV' + String(i).padStart(5, '0') });
}

test('events: a filter that matches nothing costs one bounded read per request, and the cursor continues', async function () {
    await withWorld(async function (h) {
        manyEvents(h, 600, 100);
        const reads = countReads(h);
        const alice = await session(h, 'alice');
        // no match at all: every page is one read of at most 5000 rows, and paging ends with a null cursor only when nothing is left
        let r = await call(alice, 'GET', '/api/v1/events?type=zzz&limit=10&audit=false');
        assert.strictEqual(r.status, 200); assert.strictEqual(reads.calls, 1);
        assert.ok(reads.limits.every(function (l) { return l <= 5000; }));
        assert.deepStrictEqual(r.body.items, []);
        assert.ok(r.body.next_cursor, 'a short page still carries a continuation');
        let pages = 1, cur = r.body.next_cursor;
        while (cur && pages < 50) { r = await call(alice, 'GET', '/api/v1/events?type=zzz&limit=10&audit=false&cursor=' + cur); assert.deepStrictEqual(r.body.items, []); cur = r.body.next_cursor; pages++; }
        assert.strictEqual(cur, null); assert.ok(pages >= 5 && pages < 50, 'pages: ' + pages);
        assert.strictEqual(reads.calls, pages, 'one read per request');
        assert.ok(Math.max.apply(null, reads.limits) <= 5000);
        // until in the distant past: bounded, empty, no hidden older events
        reads.calls = 0;
        r = await call(alice, 'GET', '/api/v1/events?until=2000-01-01T00:00:00Z&audit=false&limit=10');
        assert.strictEqual(reads.calls, 1); assert.deepStrictEqual(r.body.items, []);
        // sparse matches are all found by following the continuation
        const found = []; cur = null; pages = 0;
        do {
            r = await call(alice, 'GET', '/api/v1/events?type=mesh&limit=2&audit=false' + (cur ? '&cursor=' + cur : ''));
            for (const e of r.body.items) found.push(e.id);
            cur = r.body.next_cursor; pages++;
        } while (cur && pages < 60);
        assert.strictEqual(found.length, 6, found.join()); assert.strictEqual(new Set(found).size, 6);
        // a malformed depth in the cursor is refused
        const bad = Buffer.from(JSON.stringify({ t: 1, i: 'x', d: 999999 })).toString('base64url');
        assert.strictEqual((await call(alice, 'GET', '/api/v1/events?cursor=' + bad)).status, 400);
    });
});

test('events: pages through older events with the scan cursor, newest first, nothing twice', async function () {
    await withWorld(async function (h) {
        manyEvents(h, 450, 1000);
        const alice = await session(h, 'alice');
        const seen = []; let cur = null, pages = 0;
        do {
            const r = await call(alice, 'GET', '/api/v1/events?audit=false&limit=40' + (cur ? '&cursor=' + cur : ''));
            for (const e of r.body.items) seen.push(e.id);
            cur = r.body.next_cursor; pages++;
        } while (cur && pages < 40);
        assert.strictEqual(seen.length, 450); assert.strictEqual(new Set(seen).size, 450);
        assert.deepStrictEqual(seen, seen.slice().sort().reverse());
    });
});

test('events: /events and /devices/{id}/events share a per-credential limiter (429 with Retry-After)', async function () {
    await withWorld(async function (h) {
        const alice = await session(h, 'alice');
        let last;
        for (let i = 0; i < 30; i++) { last = await call(alice, 'GET', i % 2 ? '/api/v1/events' : '/api/v1/devices/' + N1 + '/events'); assert.strictEqual(last.status, 200); }
        last = await call(alice, 'GET', '/api/v1/events');
        assert.strictEqual(last.status, 429); assert.strictEqual(last.body.error.code, 'rate_limited'); assert.ok(last.headers['retry-after']);
        assert.strictEqual((await call(alice, 'GET', '/api/v1/devices')).status, 200, 'other endpoints are not affected');
        assert.strictEqual((await call(await session(h, 'bob'), 'GET', '/api/v1/events')).status, 200, 'per credential');
    }, { settings: {} });
});

// ---- privacy details ------------------------------------------------------------

test('devices: a host that is an IP literal follows the address rule; q does not match it', async function () {
    await withWorld(async function (h) {
        h.dbDocs[FN3].host = '192.0.2.99';
        h.dbDocs[FN2].host = '[2001:db8::2]';
        const ro = await token(h, 'alice', { scopes: ['read'] });
        const list = await call(h.client(), 'GET', '/api/v1/devices', bearer(ro));
        assert.strictEqual(list.body.items.find(function (d) { return d.id == N3; }).host, null);
        assert.strictEqual(list.body.items.find(function (d) { return d.id == N2; }).host, null);
        assert.strictEqual(list.body.items.find(function (d) { return d.id == N1; }).host, 'server-01.example.com');
        assert.ok(!list.text.includes('192.0.2.99') && !list.text.includes('2001:db8'));
        assert.strictEqual((await call(h.client(), 'GET', '/api/v1/devices?q=192.0.2.99', bearer(ro))).body.items.length, 0);
        assert.strictEqual((await call(h.client(), 'GET', '/api/v1/devices/' + N3, bearer(ro))).body.host, null);
        const sess = await session(h, 'alice');
        assert.strictEqual((await call(sess, 'GET', '/api/v1/devices?q=192.0.2.99')).body.items.length, 1);
        assert.strictEqual((await call(sess, 'GET', '/api/v1/devices/' + N3)).body.host, '192.0.2.99');
        const con = await token(h, 'alice', { scopes: ['read', 'console'], groups: [B] });
        assert.strictEqual((await call(h.client(), 'GET', '/api/v1/devices/' + N3, bearer(con))).body.host, '192.0.2.99');
    });
});

test('devices: hardware is null when nothing visible remains; agent.connected_at is the real time or null', async function () {
    await withWorld(async function (h) {
        h.dbDocs['si' + FN1] = { _id: 'si' + FN1, hardware: { identifiers: { bios_serial: 'SN-EXAMPLE-0001' } } };
        const ro = await token(h, 'alice', { scopes: ['read'] });
        let r = await call(h.client(), 'GET', '/api/v1/devices/' + N1, bearer(ro));
        assert.strictEqual(r.body.hardware, null);
        assert.strictEqual(r.body.agent.connected_at, null, 'unknown connection time');
        const sess = await session(h, 'alice');
        assert.strictEqual((await call(sess, 'GET', '/api/v1/devices/' + N1)).body.hardware.serial, 'SN-EXAMPLE-0001');
        h.dbDocs['lc' + FN1] = { _id: 'lc' + FN1, type: 'lastconnect', time: Date.parse('2026-01-01T09:00:00Z'), connectType: 1 };
        r = await call(sess, 'GET', '/api/v1/devices/' + N1);
        assert.strictEqual(r.body.agent.connected_at, '2026-01-01T09:00:00.000Z');
    });
});

// ---- stream hardening -------------------------------------------------------------

test('stream: a server-wide cap sits on top of the per-credential cap, and slots come back', async function () {
    await withWorld(async function (h) {
        h.core.limits.streamsTotal.max = 2;
        const a = await session(h, 'alice'), b = await session(h, 'bob');
        const s1 = await open(h, { client: a }), s2 = await open(h, { client: b });
        const s3 = await openStream(h, { client: await session(h, 'eve') });
        assert.strictEqual(s3.status, 429);
        await s3.waitFor(function (x) { return x.ended; });
        check('GET', '/api/v1/stream', { status: s3.status, headers: s3.headers, text: s3.raw, body: s3.body });
        assert.strictEqual(h.core.limits.streams.map.has('ses:user//eve/' + 'x'), false);
        s1.close();
        let s4;
        for (let i = 0; i < 100; i++) { s4 = await openStream(h, { client: await session(h, 'eve'), ignoreErrors: true }); if (s4.status == 200) break; s4.close(); await tick(); }
        assert.strictEqual(s4.status, 200);
        s2.close(); s4.close();
        for (let i = 0; i < 100 && (h.core.limits.streamsTotal.map.size > 0); i++) await tick();
        assert.strictEqual(h.core.limits.streamsTotal.map.size, 0);
        assert.strictEqual(h.core.limits.streams.map.size, 0);
    });
});

test('stream: a credential check that never answers ends the stream with closed within 5 seconds', async function () {
    await withWorld(async function (h) {
        h.core.streamOptions = { revalidateMs: 300 };
        const s = await open(h, { client: await session(h, 'alice') });
        h.core.revalidate = function () { return new Promise(function () { }); };
        const t0 = Date.now();
        assert.ok(await s.waitFor(function (x) { return x.of('closed').length > 0 && x.ended; }, 5000), 'closed');
        assert.ok(Date.now() - t0 < 5000);
        for (let i = 0; i < 50 && (h.core.limits.streams.map.size > 0); i++) await tick();
        assert.strictEqual(h.core.limits.streams.map.size, 0);
    });
});

test('stream: device.updated is coalesced per device; invisible devices cost no database read', async function () {
    await withWorld(async function (h) {
        const s = await open(h, { client: await session(h, 'alice') });
        const eve = await open(h, { client: await session(h, 'eve') });
        const gets = [];
        const orig = h.webserver.db.Get;
        h.webserver.db.Get = function (id, cb) { gets.push(id); return orig(id, cb); };
        for (let i = 0; i < 40; i++) h.dispatch({ action: 'nodeconnect', meshid: MA, nodeid: FN1, domain: '', conn: 5, pwr: 1, nolog: 1 });
        await s.waitFor(function (x) { return x.of('device.updated').length > 0; });
        await tick(); await tick(); await tick(); await tick(); await tick(); await tick(); await tick(); await tick(); await tick(); await tick();
        const n = s.of('device.updated').length;
        assert.ok(n >= 1 && n <= 4, 'coalesced: ' + n);
        assert.strictEqual(eve.messages.filter(function (m) { return m.type != 'ready'; }).length, 0);
        assert.ok(gets.filter(function (g) { return g == FN1; }).length <= 2 * n, 'reads are per sent update, not per stream per event: ' + gets.length);
        s.close(); eve.close();
    });
});

test('core.close detaches the hub from MeshCentral and the audit feed', async function () {
    const h = await world();
    const removed = [];
    h.parent.RemoveEventDispatch = function (ids, t) { removed.push(t); };
    await h.close();
    assert.strictEqual(removed.length, 1); assert.strictEqual(removed[0], h.core.hub.handler);
    assert.strictEqual(h.core.audit.onWrite, null);
});

test('events: the depth cap is reported as truncated, a true end of history is not; derived ids are distinct', async function () {
    await withWorld(async function (h) {
        const alice = await session(h, 'alice');
        // identical stored events without an id get distinct ids
        const t = '2026-02-02T00:00:00.000Z';
        for (let i = 0; i < 3; i++) mcEvent(h, { _id: undefined, nodeid: FN1, meshid: MA, ids: [FN1, MA, '*'], time: t });
        let r = await call(alice, 'GET', '/api/v1/events?audit=false');
        assert.strictEqual(r.body.items.length, 3);
        assert.strictEqual(new Set(r.body.items.map(function (e) { return e.id; })).size, 3);
        const again = await call(alice, 'GET', '/api/v1/events?audit=false');
        assert.deepStrictEqual(again.body.items.map(function (e) { return e.id; }), r.body.items.map(function (e) { return e.id; }), 'ids are stable');
        assert.ok(!('truncated' in r.body), 'true end of history');
        // more history than the depth cap: the walk ends truncated
        h.mcEvents.length = 0;
        manyEvents(h, 5200, 100000);
        let cur = null, pages = 0, last;
        const flags = [];
        do {
            last = await call(alice, 'GET', '/api/v1/events?audit=false&type=zzz&limit=200' + (cur ? '&cursor=' + cur : ''));
            flags.push(last.body.truncated === true); cur = last.body.next_cursor; pages++;
        } while (cur && pages < 30);
        assert.strictEqual(cur, null); assert.strictEqual(last.body.truncated, true);
        assert.ok(!flags.slice(0, 2).some(Boolean), 'not flagged before the cap is reached');
        // a long history that is read to its end is not flagged
        h.mcEvents.length = 0;
        manyEvents(h, 450, 100000);
        cur = null; pages = 0;
        do { last = await call(alice, 'GET', '/api/v1/events?audit=false&limit=200' + (cur ? '&cursor=' + cur : '')); assert.ok(!('truncated' in last.body)); cur = last.body.next_cursor; pages++; } while (cur && pages < 10);
    });
});

/**
 * Power actions and the console relay. In-process, with the fake MeshCentral
 * of harness.js (agents, MQTT broker and event dispatch are recorded, never
 * sent anywhere), a fake Intel AMT redirection endpoint on 127.0.0.1, and
 * every HTTP response checked against the spec.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const { start, NAME, ORIGIN, FULL } = require('./harness');
const { check } = require('./contract');
const { socketTransport } = require('../../outband/console');

const A = 'GroupAlpha0001', B = 'GroupBeta00002';
const MA = 'mesh//' + A, MB = 'mesh//' + B;
const N1 = 'NodeServer01', N2 = 'NodePeer00002', N3 = 'NodeAmtBox003';
const FN1 = 'node//' + N1, FN2 = 'node//' + N2, FN3 = 'node//' + N3;
const R = { WAKE: 0x40, RESETOFF: 0x40000, NOAMT: 0x800, REMOTECONTROL: 0x8, VIEWONLY: 0x100 };
const AMT_USER = 'admin', AMT_PASS = 'Amt-Secret-Example-1';

const USERS = {
    admin: { password: 'Admin-Pass-1', siteadmin: FULL },
    alice: { password: 'Alice-Pass-1', links: { [MA]: { rights: FULL }, [MB]: { rights: FULL } } },
    bob: { password: 'Bob-Pass-1', links: { [MA]: { rights: R.WAKE } } },
    frank: { password: 'Frank-Pass-1', links: { [MA]: { rights: R.RESETOFF } } },
    nina: { password: 'Nina-Pass-1', links: { [MA]: { rights: R.WAKE | R.RESETOFF | R.NOAMT | R.REMOTECONTROL } } },
    vera: { password: 'Vera-Pass-1', links: { [MA]: { rights: R.REMOTECONTROL | R.VIEWONLY } } },
    gina: { password: 'Gina-Pass-1', links: { [MA]: { rights: FULL } } }
};

async function world(extra) {
    const h = await start(Object.assign({ users: USERS, settings: { outbandapi: { ratelimits: { powerperminute: 1000, eventsperminute: 100000 } } } }, extra || {}));
    h.meshes[MA] = { _id: MA, name: 'Alpha', desc: '', mtype: 2, domain: '' };
    h.meshes[MB] = { _id: MB, name: 'Beta', desc: '', mtype: 1, domain: '' };
    const node = function (id, name, mesh, more) { h.dbDocs[id] = Object.assign({ _id: id, type: 'node', name: name, host: name + '.example.com', meshid: mesh, domain: '' }, more || {}); };
    node(FN1, 'server-01', MA, { intelamt: { state: 2, ver: '16.1.25', user: AMT_USER, pass: AMT_PASS, tls: 0 } });
    node(FN2, 'peer-02', MA, {});
    node(FN3, 'amt-box', MB, { intelamt: { state: 2, ver: '12.0.1', user: AMT_USER, pass: AMT_PASS, tls: 0 } });
    h.dbDocs['if' + FN1] = { _id: 'if' + FN1, netif: { 0: { mac: '00:11:22:33:44:55' } } };
    h.parent.connectivityByNode[FN1] = { connectivity: 1 | 4, powerState: 1, meshid: MA };
    h.parent.connectivityByNode[FN2] = { connectivity: 1, powerState: 1, meshid: MA };
    h.parent.connectivityByNode[FN3] = { connectivity: 4, powerState: 8, meshid: MB };
    h.sent = [];
    const agent = function (id, mesh) { return { authenticated: 2, dbNodeKey: id, dbMeshKey: mesh, send: function (m) { h.sent.push({ to: id, msg: JSON.parse(m) }); } }; };
    h.webserver.wsagents = { [FN1]: agent(FN1, MA), [FN2]: agent(FN2, MA) };
    h.mqtt = [];
    h.parent.mqttbroker = { publish: function (nodeid, topic, msg) { h.mqtt.push({ nodeid: nodeid, topic: topic, msg: msg }); } };
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
const bearer = function (t, more) { return Object.assign({ bearer: t.secret, csrf: false }, more || {}); };
const powerOf = function (h, c, id, body, opts) { return call(c, 'POST', '/api/v1/devices/' + id + '/power', Object.assign({ json: body }, opts || {})); };
const amtEvents = function (h) { return h.events.filter(function (e) { return e.action == 'amtpoweraction'; }); };
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

// ---- power ------------------------------------------------------------------

test('power: graceful off through the agent, 202 PowerResult, audited with the group', async function () {
    await withWorld(async function (h) {
        const c = await session(h, 'alice');
        const r = await powerOf(h, c, N1, { action: 'off' });
        assert.strictEqual(r.status, 202, JSON.stringify(r.body));
        assert.deepStrictEqual(r.body.paths, ['agent']);
        assert.strictEqual(r.body.status, 'dispatched'); assert.strictEqual(r.body.device_id, N1);
        assert.ok(/^act_/.test(r.body.action_id));
        assert.deepStrictEqual(h.sent.map(function (s) { return [s.to, s.msg.action, s.msg.actiontype]; }), [[FN1, 'poweraction', 2]]);
        assert.strictEqual(amtEvents(h).length, 0, 'the default off never uses AMT');
        await sleep(20);
        const a = await h.core.store.audit.find({ action: 'outband.power', outcome: 'success' });
        assert.strictEqual(a.length, 1);
        assert.strictEqual(a[0].group_id, MA); assert.strictEqual(a[0].action_id, r.body.action_id);
        // group members see it in /events
        const ev = await call(await session(h, 'gina'), 'GET', '/api/v1/events?audit=true');
        assert.ok(ev.body.items.some(function (e) { return (e.action == 'outband.power') && (e.action_id == r.body.action_id) && /dispatched through agent/.test(e.message); }));
        // reset and sleep through the agent; cycle through AMT; on through AMT
        for (const [act, t] of [['reset', 3], ['sleep', 4]]) { const x = await powerOf(h, c, N1, { action: act }); assert.strictEqual(x.status, 202); assert.strictEqual(h.sent[h.sent.length - 1].msg.actiontype, t); }
        assert.deepStrictEqual((await powerOf(h, c, N1, { action: 'cycle' })).body.paths, ['amt']);
        assert.deepStrictEqual((await powerOf(h, c, N1, { action: 'on' })).body.paths, ['amt']);
        assert.deepStrictEqual(amtEvents(h).map(function (e) { return [e.nodeids[0], e.actiontype]; }), [[FN1, 5], [FN1, 2]]);
    });
});

test('power: the device.power stream event follows when MeshCentral reports the new state', async function () {
    await withWorld(async function (h) {
        const c = await session(h, 'alice');
        const chunks = [];
        const req = http.request({ host: '127.0.0.1', port: h.port, path: '/api/v1/stream?types=device.power', headers: { host: NAME, cookie: c.cookieHeader() }, agent: false }, function (res) { res.on('data', function (d) { chunks.push(String(d)); }); });
        req.end();
        await sleep(100);
        assert.strictEqual((await powerOf(h, c, N1, { action: 'off' })).status, 202);
        h.dispatch({ etype: 'node', action: 'nodeconnect', nodeid: FN1, meshid: MA, domain: '', pwr: 8, conn: 4 });
        const until = Date.now() + 3000;
        while ((Date.now() < until) && !chunks.join('').includes('device.power')) await sleep(20);
        req.destroy();
        assert.ok(/"type":"device.power","data":\{"id":"NodeServer01","power":\{"state":"off"/.test(chunks.join('')), chunks.join(''));
    });
});

test('power: rights matrix (WAKEDEVICE, RESETOFF, NOAMT), checked before any path detail', async function () {
    await withWorld(async function (h) {
        const bob = await session(h, 'bob'), frank = await session(h, 'frank'), nina = await session(h, 'nina');
        // WAKEDEVICE only
        let r = await powerOf(h, bob, N1, { action: 'off' });
        assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error.code, 'forbidden'); assert.strictEqual(r.body.error.details.path, 'agent');
        assert.strictEqual((await powerOf(h, bob, N1, { action: 'on' })).status, 202);
        assert.strictEqual((await powerOf(h, bob, N1, { action: 'cycle' })).status, 403);
        // RESETOFF only
        assert.strictEqual((await powerOf(h, frank, N1, { action: 'on' })).status, 403);
        assert.strictEqual((await powerOf(h, frank, N1, { action: 'wake' })).status, 403);
        assert.strictEqual((await powerOf(h, frank, N1, { action: 'off', via: 'amt' })).status, 202);
        // NOAMT: AMT paths refused with details.path, others work
        r = await powerOf(h, nina, N1, { action: 'off', via: 'amt' });
        assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error.details.path, 'amt');
        assert.strictEqual((await powerOf(h, nina, N1, { action: 'on' })).status, 403);
        assert.deepStrictEqual((await powerOf(h, nina, N1, { action: 'wake' })).body.paths, ['wol'], 'wake without AMT is Wake-on-LAN only');
        assert.deepStrictEqual((await powerOf(h, nina, N1, { action: 'off' })).body.paths, ['agent', 'mqtt'].filter(function (p) { return p == 'agent'; }));
        // rights are checked before reachability: agent offline, bob still gets 403 (not 409 with paths)
        h.parent.connectivityByNode[FN1].connectivity = 4;
        r = await powerOf(h, bob, N1, { action: 'off' });
        assert.strictEqual(r.status, 403); assert.ok(!('available_paths' in r.body.error.details));
        // a device in a group the caller cannot see: 404, identical to a missing one
        const a = await powerOf(h, bob, N3, { action: 'on' }), m = await powerOf(h, bob, 'NodeMissing0001', { action: 'on' });
        assert.strictEqual(a.status, 404); delete a.body.error.request_id; delete m.body.error.request_id; assert.deepStrictEqual(a.body, m.body);
        // scope: power_on does not allow off
        const t = await token(h, 'alice', { scopes: ['read', 'power_on'] });
        r = await powerOf(h, h.client(), N1, { action: 'off' }, bearer(t));
        assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error.code, 'insufficient_scope');
        await sleep(20);
        const denied = await h.core.store.audit.find({ action: 'outband.power', outcome: 'denied' });
        assert.ok(denied.length >= 3);
        assert.ok(denied.every(function (d) { return d.group_id == null; }), 'denials carry no group');
        // denials are visible to the actor, not to other members of the group
        const mine = await call(bob, 'GET', '/api/v1/events?audit=true');
        assert.ok(mine.body.items.some(function (e) { return (e.action == 'outband.power') && (e.outcome == 'denied'); }));
        const other = await call(await session(h, 'gina'), 'GET', '/api/v1/events?audit=true');
        assert.ok(!other.body.items.some(function (e) { return (e.action == 'outband.power') && (e.outcome == 'denied'); }));
        const nf = await h.core.store.audit.find({ action: 'outband.not_found' });
        assert.ok(nf.length >= 1, '404 audited');
    });
});

test('power: path rules (agent offline + AMT, MQTT, Wake-on-LAN); never a silent switch', async function () {
    await withWorld(async function (h) {
        const c = await session(h, 'alice');
        // agent and MQTT connected: off goes out on both
        h.parent.connectivityByNode[FN1].connectivity = 1 | 4 | 16;
        let r = await powerOf(h, c, N1, { action: 'off' });
        assert.deepStrictEqual(r.body.paths, ['agent', 'mqtt']);
        assert.deepStrictEqual(h.mqtt.pop(), { nodeid: FN1, topic: 'powerAction', msg: 'poweroff' });
        // agent offline, AMT reachable: off is absent from capabilities, 409 with available_paths, via=amt works
        h.parent.connectivityByNode[FN1].connectivity = 4;
        const caps = (await call(c, 'GET', '/api/v1/devices/' + N1)).body.capabilities;
        assert.ok(!caps.power.includes('off') && !('off' in caps.power_via));
        assert.deepStrictEqual(caps.power_paths.off, ['amt']);
        const before = h.sent.length;
        r = await powerOf(h, c, N1, { action: 'off' });
        assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error.code, 'not_reachable');
        assert.deepStrictEqual(r.body.error.details, { path: 'agent', available_paths: ['amt'] });
        assert.strictEqual(h.sent.length, before, 'nothing dispatched');
        r = await powerOf(h, c, N1, { action: 'off', via: 'amt' });
        assert.strictEqual(r.status, 202); assert.deepStrictEqual(r.body.paths, ['amt']);
        assert.strictEqual(amtEvents(h).pop().actiontype, 8);
        r = await powerOf(h, c, N1, { action: 'reset', via: 'amt' });
        assert.strictEqual(amtEvents(h).pop().actiontype, 10);
        // via a path that cannot carry it now: 409 with details.path, no fallback
        r = await powerOf(h, c, N1, { action: 'off', via: 'agent' });
        assert.strictEqual(r.status, 409); assert.deepStrictEqual(r.body.error.details, { path: 'agent' });
        // via not allowed for the action: 400
        r = await powerOf(h, c, N1, { action: 'sleep', via: 'amt' });
        assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error.details.field, 'via');
        // MQTT only: the same rule, the request must carry via=mqtt
        h.parent.connectivityByNode[FN1].connectivity = 16;
        r = await powerOf(h, c, N1, { action: 'sleep' });
        assert.strictEqual(r.status, 409); assert.deepStrictEqual(r.body.error.details, { path: 'agent', available_paths: ['mqtt'] });
        r = await powerOf(h, c, N1, { action: 'sleep', via: 'mqtt' });
        assert.strictEqual(r.status, 202); assert.deepStrictEqual(h.mqtt.pop(), { nodeid: FN1, topic: 'powerAction', msg: 'sleep' });
        // wake: Wake-on-LAN from the peer agent plus AMT; via=wol uses only Wake-on-LAN
        h.parent.connectivityByNode[FN1].connectivity = 4;
        h.sent.length = 0;
        r = await powerOf(h, c, N1, { action: 'wake' });
        assert.deepStrictEqual(r.body.paths, ['wol', 'amt']);
        assert.deepStrictEqual(h.sent, [{ to: FN2, msg: { action: 'wakeonlan', macs: ['00:11:22:33:44:55'] } }]);
        const nAmt = amtEvents(h).length;
        r = await powerOf(h, c, N1, { action: 'wake', via: 'wol' });
        assert.deepStrictEqual(r.body.paths, ['wol']); assert.strictEqual(amtEvents(h).length, nAmt, 'no AMT with via=wol');
        // an AMT-only group: off has no default, via=amt
        r = await powerOf(h, c, N3, { action: 'off' });
        assert.strictEqual(r.status, 409); assert.deepStrictEqual(r.body.error.details, { path: null, available_paths: ['amt'] });
    });
});

test('power: Idempotency-Key replays without dispatching; another body conflicts; scope before lookup', async function () {
    await withWorld(async function (h) {
        const c = await session(h, 'alice');
        const key = { headers: { 'idempotency-key': 'example-retry-key-0001' } };
        const r1 = await powerOf(h, c, N1, { action: 'off' }, key);
        const r2 = await powerOf(h, c, N1, { action: 'off' }, key);
        assert.strictEqual(r1.status, 202); assert.strictEqual(r2.status, 202);
        assert.deepStrictEqual(r2.body, r1.body);
        assert.strictEqual(h.sent.length, 1, 'dispatched once');
        const r3 = await powerOf(h, c, N1, { action: 'reset' }, key);
        assert.strictEqual(r3.status, 409); assert.strictEqual(r3.body.error.code, 'idempotency_conflict');
        // another credential with the same key is a different request
        const g = await session(h, 'gina');
        assert.notStrictEqual((await powerOf(h, g, N1, { action: 'off' }, key)).body.action_id, r1.body.action_id);
        // a token without the power scope gets 403 even with a key stored for another credential
        const t = await token(h, 'alice', { scopes: ['read'] });
        const r4 = await powerOf(h, h.client(), N1, { action: 'off' }, bearer(t, key));
        assert.strictEqual(r4.status, 403); assert.strictEqual(r4.body.error.code, 'insufficient_scope');
    });
});

test('power: 6 actions per minute per device, across callers; replays do not count', async function () {
    await withWorld(async function (h) {
        const a = await session(h, 'alice'), g = await session(h, 'gina');
        const key = { headers: { 'idempotency-key': 'example-limit-key-0001' } };
        for (let i = 0; i < 6; i++) {
            const r = await powerOf(h, (i % 2) ? a : g, N1, { action: 'on' }, (i == 0) ? key : undefined);
            assert.strictEqual(r.status, 202, 'action ' + i);
        }
        assert.strictEqual((await powerOf(h, g, N1, { action: 'on' }, key)).status, 202, 'a replay is answered from the stored result');
        const r = await powerOf(h, a, N1, { action: 'on' });
        assert.strictEqual(r.status, 429); assert.ok(Number(r.headers['retry-after']) > 0);
        assert.strictEqual(amtEvents(h).length, 6);
        // another device is not affected
        assert.strictEqual((await powerOf(h, a, N3, { action: 'on' })).status, 202);
    });
});

// ---- console ----------------------------------------------------------------

/** A fake Intel AMT redirection endpoint: digest authentication, SOL settings, echoes terminal bytes in upper case. */
function fakeAmt(user, pass, tlsOptions) {
    const seen = { auth: false, data: [], connections: 0, sockets: [] };
    const handler = function (sock) {
        seen.connections++; seen.sockets.push(sock);
        let acc = Buffer.alloc(0);
        const nonce = crypto.randomBytes(8).toString('hex'), realm = 'Digest:EXAMPLE', qop = 'auth';
        const lstr = function (s) { return Buffer.concat([Buffer.from([Buffer.byteLength(s)]), Buffer.from(s)]); };
        const u32 = function (n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
        const md5 = function (s) { return crypto.createHash('md5').update(s).digest('hex'); };
        sock.on('error', function () { });
        sock.on('data', function (d) {
            acc = Buffer.concat([acc, d]);
            for (;;) {
                if (acc.length == 0) return;
                const t = acc[0];
                if (t == 0x10) { if (acc.length < 8) return; acc = acc.subarray(8); sock.write(Buffer.concat([Buffer.from([0x11, 0, 0, 0]), Buffer.alloc(8), Buffer.from([0])])); }
                else if (t == 0x13) {
                    if (acc.length < 9) return;
                    const len = acc.readUInt32LE(5); if (acc.length < 9 + len) return;
                    const type = acc[4], body = acc.subarray(9, 9 + len); acc = acc.subarray(9 + len);
                    if (type == 0) { sock.write(Buffer.concat([Buffer.from([0x14, 0, 0, 0, 0]), u32(1), Buffer.from([4])])); }
                    else if ((type == 4) && (body.length == Buffer.byteLength(user) + AUTHLEN)) {
                        const b = Buffer.concat([lstr(realm), lstr(nonce), lstr(qop)]);
                        sock.write(Buffer.concat([Buffer.from([0x14, 1, 0, 0, 4]), u32(b.length), b]));
                    } else if (type == 4) {
                        let p = 0; const f = function () { const l = body[p]; const v = body.subarray(p + 1, p + 1 + l).toString(); p += l + 1; return v; };
                        const u = f(), rl = f(), n = f(), uri = f(), cn = f(), nc = f(), dg = f(), q = f();
                        const want = md5(md5(user + ':' + rl + ':' + pass) + ':' + n + ':' + nc + ':' + cn + ':' + q + ':' + md5('POST:' + uri));
                        if ((u == user) && (dg == want)) { seen.auth = true; sock.write(Buffer.concat([Buffer.from([0x14, 0, 0, 0, 4]), u32(0)])); }
                        else { sock.write(Buffer.concat([Buffer.from([0x14, 2, 0, 0, 4]), u32(0)])); sock.end(); }
                    }
                } else if (t == 0x20) { if (acc.length < 24) return; acc = acc.subarray(24); sock.write(Buffer.concat([Buffer.from([0x21]), Buffer.alloc(22)])); }
                else if (t == 0x27) { if (acc.length < 14) return; acc = acc.subarray(14); }
                else if (t == 0x2B) { if (acc.length < 8) return; acc = acc.subarray(8); }
                else if (t == 0x28) {
                    if (acc.length < 10) return;
                    const l = acc.readUInt16LE(8); if (acc.length < 10 + l) return;
                    const data = acc.subarray(10, 10 + l); acc = acc.subarray(10 + l);
                    seen.data.push(data.toString());
                    const out = Buffer.from(data.toString().toUpperCase());
                    const hdr = Buffer.from([0x2A, 0, 0, 0, 0, 0, 0, 0, 0, 0]); hdr.writeUInt16LE(out.length, 8);
                    sock.write(Buffer.concat([hdr, out]));
                } else { sock.destroy(); return; }
            }
        });
    };
    const server = tlsOptions ? require('tls').createServer(tlsOptions, handler) : net.createServer(handler);
    const AUTHLEN = 2 + 1 + '/RedirectionService'.length + 4 + 1; // user prefix, two empty fields, uri, four zero bytes
    return new Promise(function (resolve) { server.listen(0, '127.0.0.1', function () { seen.port = server.address().port; seen.close = function () { for (const s of seen.sockets) s.destroy(); return new Promise(function (r) { server.close(r); }); }; resolve(seen); }); });
}

async function consoleWorld(fn, consoleOptions) {
    const amt = await fakeAmt(AMT_USER, AMT_PASS);
    await withWorld(async function (h) {
        h.core.consoleOptions = Object.assign({ connect: function () { return socketTransport(net.connect(amt.port, '127.0.0.1'), 'connect', null); } }, consoleOptions || {});
        await fn(h, amt);
    });
    await amt.close();
}

async function ticketFor(h, o, id) {
    const r = await call(o.client || h.client(), 'POST', '/api/v1/devices/' + (id || N1) + '/console/sol/ticket', o.bearer ? bearer(o.bearer) : {});
    return r;
}

/** Open the console WebSocket; resolves when the handshake completes (or fails). */
function openWs(h, protocols, o) {
    o = o || {};
    const headers = { host: NAME };
    if (o.client) { headers.cookie = o.client.cookieHeader(); headers.origin = ORIGIN; }
    if (o.bearer) { headers.authorization = 'Bearer ' + o.bearer.secret; headers['x-forwarded-proto'] = 'https'; }
    Object.assign(headers, o.headers || {});
    const w = new WebSocket('ws://127.0.0.1:' + h.port + '/api/v1/devices/' + (o.id || N1) + '/console/sol', protocols, { headers: headers });
    const s = { ws: w, frames: [], states: [], closeCode: null, closedAt: null, error: null };
    w.on('message', function (d, isBinary) { if (isBinary) s.frames.push(Buffer.from(d).toString()); else s.states.push(JSON.parse(String(d))); });
    w.on('close', function (code) { s.closeCode = code; s.closedAt = Date.now(); });
    w.on('error', function (e) { s.error = e; });
    s.waitFor = async function (pred, ms) { const until = Date.now() + (ms || 5000); while (Date.now() < until) { if (pred(s)) return true; await sleep(20); } return pred(s); };
    s.closed = function (ms) { return s.waitFor(function (x) { return x.closeCode != null; }, ms); };
    return new Promise(function (resolve) { w.on('open', function () { resolve(s); }); w.on('close', function () { resolve(s); }); w.on('error', function () { resolve(s); }); });
}
const protocolsOf = function (t) { return t.body.protocols; };

test('console: SOL relay through the server-held AMT credentials; only outband.console.v1 is answered', async function () {
    await consoleWorld(async function (h, amt) {
        const c = await session(h, 'alice');
        const t = await ticketFor(h, { client: c });
        assert.strictEqual(t.status, 201, JSON.stringify(t.body));
        assert.ok(!t.body.url.includes('ticket'));
        const s = await openWs(h, protocolsOf(t), { client: c });
        assert.strictEqual(s.ws.protocol, 'outband.console.v1');
        assert.ok(await s.waitFor(function (x) { return x.states.some(function (m) { return m.state == 'open'; }); }), JSON.stringify(s.states));
        assert.strictEqual(amt.auth, true, 'the server authenticated to AMT');
        s.ws.send(Buffer.from('hello sol'));
        s.ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 })); // ignored for SOL
        assert.ok(await s.waitFor(function (x) { return x.frames.join('').includes('HELLO SOL'); }));
        assert.deepStrictEqual(amt.data, ['hello sol']);
        const everything = JSON.stringify(s.states) + s.frames.join('');
        assert.ok(!everything.includes(AMT_PASS) && !everything.includes('Digest'), 'AMT credentials never reach the client');
        await sleep(20);
        const opened = await h.core.store.audit.find({ action: 'outband.console.open' });
        assert.strictEqual(opened.length, 1); assert.strictEqual(opened[0].group_id, MA);
        s.ws.close();
        assert.ok(await s.closed());
        await sleep(50);
        assert.strictEqual(h.core.consoles.busy.size, 0, 'the device is free again');
    });
});

test('console: the ticket is single use, never echoed, and needs the console subprotocol', async function () {
    await consoleWorld(async function (h) {
        const c = await session(h, 'alice');
        // raw upgrades: whatever the order, the answer is outband.console.v1 or nothing
        const rawUpgrade = function (protocols) {
            return new Promise(function (resolve) {
                const req = http.request({ host: '127.0.0.1', port: h.port, path: '/api/v1/devices/' + N1 + '/console/sol', headers: { host: NAME, cookie: c.cookieHeader(), origin: ORIGIN, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': crypto.randomBytes(16).toString('base64'), 'sec-websocket-protocol': protocols } });
                req.on('upgrade', function (res, sock) { sock.destroy(); resolve(res.headers['sec-websocket-protocol'] || null); });
                req.on('response', function (res) { resolve('http ' + res.statusCode); });
                req.on('error', function () { resolve('error'); });
                req.end();
            });
        };
        let t = await ticketFor(h, { client: c });
        const tp = protocolsOf(t)[1];
        assert.strictEqual(await rawUpgrade(tp + ', outband.console.v1'), 'outband.console.v1', 'ticket first: still not echoed');
        t = await ticketFor(h, { client: c });
        assert.strictEqual(await rawUpgrade(protocolsOf(t)[1]), null, 'no console subprotocol: nothing is answered');
        // single use
        t = await ticketFor(h, { client: c });
        const s1 = await openWs(h, protocolsOf(t), { client: c });
        await s1.waitFor(function (x) { return x.states.some(function (m) { return m.state == 'open'; }); });
        s1.ws.close(); await s1.closed(); await sleep(50);
        const s2 = await openWs(h, protocolsOf(t), { client: c });
        assert.ok(await s2.closed()); assert.strictEqual(s2.closeCode, 4401);
        // a ticket in the URL is refused before anything else
        const u = await c.get('/api/v1/devices/' + N1 + '/console/sol?ticket=x');
        assert.strictEqual(u.status, 400);
        // a cookie ticket needs the matching Origin
        t = await ticketFor(h, { client: c });
        const s3 = await openWs(h, protocolsOf(t), { client: c, headers: { origin: 'https://evil.example.net' } });
        assert.ok(await s3.closed()); assert.strictEqual(s3.closeCode, 4401);
    });
});

test('console: a bearer ticket needs Authorization at the upgrade; scope, rights and busy', async function () {
    await consoleWorld(async function (h) {
        const t = await token(h, 'alice', { scopes: ['read', 'console'], groups: [A], expires_in_days: 30 });
        let tk = await ticketFor(h, { bearer: t });
        assert.strictEqual(tk.status, 201, JSON.stringify(tk.body));
        let s = await openWs(h, protocolsOf(tk), {});
        assert.ok(await s.closed()); assert.strictEqual(s.closeCode, 4403, 'no Authorization');
        // the owner's cookie is not the token
        tk = await ticketFor(h, { bearer: t });
        s = await openWs(h, protocolsOf(tk), { client: t.owner });
        assert.ok(await s.closed()); assert.strictEqual(s.closeCode, 4403);
        // with Authorization it opens
        tk = await ticketFor(h, { bearer: t });
        const tk2 = await ticketFor(h, { bearer: t }); // issued while the device is free
        s = await openWs(h, protocolsOf(tk), { bearer: t });
        assert.ok(await s.waitFor(function (x) { return x.states.some(function (m) { return m.state == 'open'; }); }));
        // busy: a new ticket gets 409 busy, an earlier ticket closes 4409 at the upgrade
        const b = await ticketFor(h, { bearer: t });
        assert.strictEqual(b.status, 409); assert.strictEqual(b.body.error.code, 'busy');
        const s2 = await openWs(h, protocolsOf(tk2), { bearer: t });
        assert.ok(await s2.closed()); assert.strictEqual(s2.closeCode, 4409);
        assert.ok(s.closeCode == null, 'the first session stays open');
        s.ws.close(); await s.closed();
        // group restriction: a device outside the token's groups is 404
        const out = await ticketFor(h, { bearer: t }, N3);
        assert.strictEqual(out.status, 404);
        // rights: view-only and NOAMT are refused (403, audited); terminal is not available yet
        const v = await ticketFor(h, { client: await session(h, 'vera') });
        assert.strictEqual(v.status, 403);
        const n = await ticketFor(h, { client: await session(h, 'nina') });
        assert.strictEqual(n.status, 403);
        const term = await call(await session(h, 'alice'), 'POST', '/api/v1/devices/' + N1 + '/console/terminal/ticket');
        assert.strictEqual(term.status, 409); assert.strictEqual(term.body.error.code, 'not_supported');
        // not reachable
        h.parent.connectivityByNode[FN1].connectivity = 1;
        const nr = await ticketFor(h, { client: await session(h, 'alice') });
        assert.strictEqual(nr.status, 409); assert.strictEqual(nr.body.error.code, 'not_reachable');
    });
});

test('console: revocation closes with 4403 within 5 seconds (token revoked, kill switch, logout)', async function () {
    await consoleWorld(async function (h) {
        const within5 = async function (s, t0) { assert.ok(await s.closed(5000), 'closed'); assert.strictEqual(s.closeCode, 4403); assert.ok(s.closedAt - t0 < 5000); };
        const opened = function (s) { return s.waitFor(function (x) { return x.states.some(function (m) { return m.state == 'open'; }); }); };
        // token revoked
        let t = await token(h, 'alice', { scopes: ['read', 'console'], groups: [A], expires_in_days: 30 });
        let s = await openWs(h, protocolsOf(await ticketFor(h, { bearer: t })), { bearer: t });
        assert.ok(await opened(s));
        let t0 = Date.now();
        await t.owner.del('/api/v1/auth/tokens/' + t.id);
        await within5(s, t0);
        // kill switch
        await sleep(50);
        t = await token(h, 'alice', { scopes: ['read', 'console'], groups: [A], expires_in_days: 30 });
        s = await openWs(h, protocolsOf(await ticketFor(h, { bearer: t })), { bearer: t });
        assert.ok(await opened(s));
        const adm = await session(h, 'admin');
        t0 = Date.now();
        assert.strictEqual((await adm.put('/api/v1/admin/settings', { json: { bearer: false } })).status, 200);
        await within5(s, t0);
        await adm.put('/api/v1/admin/settings', { json: { bearer: true } });
        // token expiry: no event, the periodic re-check
        await sleep(50);
        t = await token(h, 'alice', { scopes: ['read', 'console'], groups: [A], expires_in_days: 30 });
        s = await openWs(h, protocolsOf(await ticketFor(h, { bearer: t })), { bearer: t });
        assert.ok(await opened(s));
        t0 = Date.now();
        await h.core.store.tokens.update({ _id: t.id }, { $set: { expires: Date.now() - 1000 } });
        await within5(s, t0);
        // logout of the cookie session
        await sleep(50);
        const c = await session(h, 'alice');
        s = await openWs(h, protocolsOf(await ticketFor(h, { client: c })), { client: c });
        assert.ok(await opened(s));
        t0 = Date.now();
        await c.post('/api/v1/auth/logout');
        await within5(s, t0);
    });
});

test('console: rights lost mid-session close 4403; device unreachable 4409; frame and idle limits', async function () {
    await consoleWorld(async function (h) {
        const opened = function (s) { return s.waitFor(function (x) { return x.states.some(function (m) { return m.state == 'open'; }); }); };
        // rights lost (MeshCentral changes the user's links): within 5 s
        const c = await session(h, 'gina');
        let s = await openWs(h, protocolsOf(await ticketFor(h, { client: c })), { client: c });
        assert.ok(await opened(s));
        let t0 = Date.now();
        h.dbDocs['user//gina'].links = { [MA]: { rights: R.REMOTECONTROL | R.NOAMT } };
        assert.ok(await s.closed(5000)); assert.strictEqual(s.closeCode, 4403); assert.ok(s.closedAt - t0 < 5000);
        assert.strictEqual(s.states.pop().reason, 'rights');
        // locked user
        await sleep(50);
        const a = await session(h, 'alice');
        s = await openWs(h, protocolsOf(await ticketFor(h, { client: a })), { client: a });
        assert.ok(await opened(s));
        t0 = Date.now();
        h.dbDocs['user//alice'].siteadmin = 32;
        assert.ok(await s.closed(5000)); assert.strictEqual(s.closeCode, 4403); assert.ok(s.closedAt - t0 < 5000);
        h.dbDocs['user//alice'].siteadmin = 0;
        // device no longer reachable
        await sleep(50);
        const a2 = await session(h, 'alice');
        s = await openWs(h, protocolsOf(await ticketFor(h, { client: a2 })), { client: a2 });
        assert.ok(await opened(s));
        h.parent.connectivityByNode[FN1].connectivity = 1;
        assert.ok(await s.closed(5000)); assert.strictEqual(s.closeCode, 4409);
        h.parent.connectivityByNode[FN1].connectivity = 1 | 4;
        // a frame over the limit
        await sleep(50);
        s = await openWs(h, protocolsOf(await ticketFor(h, { client: a2 })), { client: a2 });
        assert.ok(await opened(s));
        s.ws.send(Buffer.alloc(20000, 0x41));
        assert.ok(await s.closed(3000)); assert.strictEqual(s.closeCode, 1009);
        // idle
        await sleep(50);
        h.core.consoleOptions.idleMs = 300;
        s = await openWs(h, protocolsOf(await ticketFor(h, { client: a2 })), { client: a2 });
        assert.ok(await opened(s));
        assert.ok(await s.closed(3000)); assert.strictEqual(s.closeCode, 1000); assert.strictEqual(s.states.pop().reason, 'idle');
        await sleep(50);
        assert.strictEqual(h.core.consoles.busy.size, 0);
    });
});

test('console: the device side closing ends the session with 4409; a refused AMT login never opens', async function () {
    await consoleWorld(async function (h, amt) {
        const a = await session(h, 'alice');
        let s = await openWs(h, protocolsOf(await ticketFor(h, { client: a })), { client: a });
        assert.ok(await s.waitFor(function (x) { return x.states.some(function (m) { return m.state == 'open'; }); }));
        for (const sock of amt.sockets) sock.destroy();
        assert.ok(await s.closed(3000)); assert.strictEqual(s.closeCode, 4409);
        // wrong stored AMT password: authentication fails, nothing opens
        h.dbDocs[FN1].intelamt.pass = 'wrong';
        s = await openWs(h, protocolsOf(await ticketFor(h, { client: a })), { client: a });
        assert.ok(await s.closed(3000)); assert.strictEqual(s.closeCode, 4409);
        assert.ok(!s.states.some(function (m) { return m.state == 'open'; }));
    });
});

test('console: MeshCentral CIRA channel transport (plain port), and the AMT certificate pin', async function () {
    const amt = await fakeAmt(AMT_USER, AMT_PASS);
    try {
        await withWorld(async function (h) {
            const used = [];
            // A CIRA connection as MeshCentral's MPS server exposes it, carried here over a local socket.
            h.parent.mpsserver = {
                GetConnectionToNode: function (nodeid, port, oob) { used.push([nodeid, oob]); return (nodeid == FN1) ? { tag: { boundPorts: [16992, 16994] } } : null; },
                SetupChannel: function (conn, port) {
                    used.push(port);
                    const sock = net.connect(amt.port, '127.0.0.1');
                    const chnl = { state: 1, write: function (d) { sock.write(d); return true; }, close: function () { if (chnl.state == 0) return; chnl.state = 0; sock.destroy(); if (chnl.onStateChange) chnl.onStateChange(chnl, 0); } };
                    sock.on('connect', function () { chnl.state = 2; chnl.onStateChange(chnl, 2); });
                    sock.on('data', function (d) { chnl.onData(chnl, d); });
                    sock.on('close', function () { chnl.close(); });
                    sock.on('error', function () { });
                    return chnl;
                }
            };
            const c = await session(h, 'alice');
            const s = await openWs(h, protocolsOf(await ticketFor(h, { client: c })), { client: c });
            assert.ok(await s.waitFor(function (x) { return x.states.some(function (m) { return m.state == 'open'; }); }), JSON.stringify(s.states));
            assert.deepStrictEqual(used, [[FN1, true], 16994], 'an out-of-band CIRA connection, non-TLS redirection port');
            s.ws.send(Buffer.from('cira'));
            assert.ok(await s.waitFor(function (x) { return x.frames.join('').includes('CIRA'); }));
            s.ws.close(); await s.closed();
        });
    } finally { await amt.close(); }
    const { certMatches } = require('../../outband/console');
    const raw = Buffer.from('example certificate bytes');
    const cert = { raw: raw, fingerprint: crypto.createHash('sha1').update(raw).digest('hex').toUpperCase().match(/../g).join(':') };
    assert.strictEqual(certMatches(cert, null), true, 'no stored hash: accepted, as MeshCentral does');
    assert.strictEqual(certMatches(cert, crypto.createHash('sha384').update(raw).digest('hex')), true);
    assert.strictEqual(certMatches(cert, crypto.createHash('sha256').update(raw).digest('hex')), true);
    assert.strictEqual(certMatches(cert, cert.fingerprint.split(':').join('').toLowerCase()), true);
    assert.strictEqual(certMatches(cert, crypto.createHash('sha384').update('other').digest('hex')), false);
});

/** A self-signed certificate for the fake AMT TLS endpoint. */
function selfSigned() {
    const forge = require('node-forge');
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey; cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 86400000); cert.validity.notAfter = new Date(Date.now() + 86400000);
    const attrs = [{ name: 'commonName', value: 'amt.example.com' }];
    cert.setSubject(attrs); cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
    return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert), sha384: crypto.createHash('sha384').update(der).digest('hex') };
}

test('console: CIRA with TLS (redirection port 16995): the stored certificate hash is enforced', async function () {
    const cert = selfSigned();
    const amt = await fakeAmt(AMT_USER, AMT_PASS, { key: cert.key, cert: cert.cert });
    try {
        await withWorld(async function (h) {
            h.parent.mpsserver = {
                GetConnectionToNode: function () { return { tag: { boundPorts: [16993, 16995] } }; },
                SetupChannel: function (conn, port) {
                    assert.strictEqual(port, 16995);
                    const sock = net.connect(amt.port, '127.0.0.1');
                    const chnl = { state: 1, write: function (d) { sock.write(d); return true; }, close: function () { if (chnl.state == 0) return; chnl.state = 0; sock.destroy(); if (chnl.onStateChange) chnl.onStateChange(chnl, 0); } };
                    sock.on('connect', function () { chnl.state = 2; if (chnl.onStateChange) chnl.onStateChange(chnl, 2); });
                    sock.on('data', function (d) { chnl.onData(chnl, d); });
                    sock.on('close', function () { chnl.close(); });
                    sock.on('error', function () { });
                    return chnl;
                }
            };
            const c = await session(h, 'alice');
            h.dbDocs[FN1].intelamt.hash = cert.sha384;
            let s = await openWs(h, protocolsOf(await ticketFor(h, { client: c })), { client: c });
            assert.ok(await s.waitFor(function (x) { return x.states.some(function (m) { return m.state == 'open'; }); }), JSON.stringify(s.states));
            s.ws.send(Buffer.from('tls'));
            assert.ok(await s.waitFor(function (x) { return x.frames.join('').includes('TLS'); }));
            s.ws.close(); await s.closed(); await sleep(50);
            // another certificate than the one MeshCentral stored: refused before any credential is sent
            h.dbDocs[FN1].intelamt.hash = crypto.createHash('sha384').update('another certificate').digest('hex');
            amt.auth = false;
            s = await openWs(h, protocolsOf(await ticketFor(h, { client: c })), { client: c });
            assert.ok(await s.closed(5000)); assert.strictEqual(s.closeCode, 4409);
            assert.strictEqual(amt.auth, false);
        });
    } finally { await amt.close(); }
});

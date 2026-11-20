/**
 * In-process test harness: the Outband router on a plain express app with a
 * fake MeshCentral webserver/parent. No network access beyond 127.0.0.1.
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const express = require('express');

const NAME = 'outband.example.com';
const ORIGIN = 'https://' + NAME;
const FULL = 0xFFFFFFFF;

function makeUser(name, opts) {
    return Object.assign({ _id: 'user//' + name, type: 'user', name: name, domain: '', email: name + '@example.com', emailVerified: true, siteadmin: 0, links: {}, salt: 'x' }, opts || {});
}

/**
 * @param {object} [o]
 *   users: {name: {password, ...userFields}}
 *   settings: extra parent.config.settings
 *   domain: extra domain fields
 *   args: extra webserver args
 */
async function start(o) {
    o = o || {};
    const domain = Object.assign({ id: '', url: '/', title: 'Outband test' }, o.domain || {});
    const users = {}, passwords = {}, dbDocs = {};
    for (const n of Object.keys(o.users || {})) {
        const u = o.users[n];
        passwords[n] = u.password;
        const doc = makeUser(n, Object.assign({}, u, { password: undefined }));
        delete doc.password;
        users[doc._id] = doc;
        dbDocs[doc._id] = doc;
    }
    const meshes = {};
    const badLogins = { blocked: false };
    const events = [];
    const mcEvents = [];
    const eventTargets = [];
    const webserver = {
        users: users, meshes: meshes, userGroups: {}, destroyedSessions: {},
        args: Object.assign({ port: 443, trustedproxy: ['127.0.0.1'] }, o.args || {}),
        certificates: { CommonName: (o.cn != null) ? o.cn : NAME },
        db: {
            Get: function (id, cb) { const d = dbDocs[id]; setImmediate(function () { cb(null, d ? [JSON.parse(JSON.stringify(d))] : []); }); },
            SetUser: function (u) { dbDocs[u._id] = JSON.parse(JSON.stringify(u)); },
            GetAllTypeNoTypeFieldMeshFiltered: function (meshIds, extra, domainId, type, id, offset, limit, filter, cb) {
                const out = Object.values(dbDocs).filter(function (d) { return (d.type == type) && (d.domain == domainId) && (meshIds.indexOf(d.meshid) >= 0); });
                setImmediate(function () { cb(null, JSON.parse(JSON.stringify(out))); });
            },
            GetEventsWithLimit: function (ids, domainId, limit, filter, cb) {
                const out = mcEvents.filter(function (e) { return (e.domain == domainId) && ((ids.indexOf('*') >= 0) || (e.ids || []).some(function (i) { return ids.indexOf(i) >= 0; })); })
                    .sort(function (a, b) { return new Date(b.time) - new Date(a.time); }).slice(0, limit);
                setImmediate(function () { cb(null, JSON.parse(JSON.stringify(out))); });
            }
        },
        authenticate: function (name, pass, d, fn) {
            const id = 'user//' + name.toLowerCase();
            const u = users[id];
            setImmediate(function () {
                if (!u || passwords[name.toLowerCase()] !== pass) return fn(new Error('invalid password'));
                if ((u.siteadmin != FULL) && (u.siteadmin & 32)) return fn('locked');
                fn(null, id);
            });
        },
        GetMeshRights: function (user, meshid) { if (typeof meshid != 'string') meshid = meshid._id; const l = user.links && user.links[meshid]; return l ? l.rights : 0; },
        CloneSafeUser: function (u) { return { _id: u._id, name: u.name }; },
        getLanguageCodes: function () { return ['en']; },
        checkAllowLogin: function () { return !badLogins.blocked; },
        setbadLogin: function () { },
        checkAllow2Fa: function () { return true; },
        setbad2Fa: function () { badLogins.bad2fa = (badLogins.bad2fa || 0) + 1; },
        force2factorPending: function () { return false; }
    };
    const debugLines = [];
    const parent = {
        datapath: null, currentVer: '1.3.1',
        config: { settings: Object.assign({}, o.settings || {}), domains: { '': domain } },
        debugSources: '*',
        debug: function (source, ...args) { debugLines.push([source].concat(args).map(function (a) { return (typeof a == 'string') ? a : JSON.stringify(a); }).join(' ')); },
        DispatchEvent: function (ids, src, ev) { events.push(ev); },
        AddEventDispatch: function (ids, target) { eventTargets.push(target); },
        connectivityByNode: {},
        authLog: function (...a) { debugLines.push('AUTHLOG ' + a.map(function (x) { return (typeof x == 'string') ? x : JSON.stringify(x); }).join(' ')); },
        addServerWarning: function () { }
    };
    Object.assign(parent, o.parent || {});
    const hooks = {
        checkUserOneTimePasswordRequired: function (d, user) { return !!user.otpsecret; },
        checkUserOneTimePassword: function (req, d, user, token, hw, cb) { setImmediate(function () { cb(token === user.testcode); }); },
        userHasSecondFactor: function (d, user) { return !!user.otpsecret; },
        setSessionRandom: function (req) { if (req.session.x != null) return; req.session.x = crypto.randomBytes(6).toString('base64'); core.onNewSession(req); }
    };
    const core = require('../../outband').create(webserver, parent, hooks, Object.assign({ inMemory: true, noTimers: true }, o.coreOptions || {}));
    await core.ready;

    const app = express();
    app.use(require('cookie-session')({ name: 'xid', keys: ['test-key'], httpOnly: true, sameSite: 'lax' }));
    app.use(async function (req, res, next) {
        await core.ready;
        req.clientIp = req.headers['x-test-ip'] || '127.0.0.1';
        req.xdomain = domain;
        if (req.headers['x-test-logintoken'] && req.session.userid) { req.session.loginToken = 'user//tokenuser'; } // simulate a MeshCentral login-token session
        if (typeof req.session.userid == 'string') {
            if ((typeof req.session.x != 'string') || (webserver.destroyedSessions[req.session.userid + '/' + req.session.x] != null) || (core.sessionValid(req.session) == false)) {
                delete req.session.userid; delete req.session.ip; delete req.session.t; delete req.session.x;
            }
        }
        next();
    });
    app.use('/api/v1', core.router());
    const server = http.createServer(app);
    await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
    const port = server.address().port;

    return {
        core, webserver, parent, users, dbDocs, meshes, badLogins, events, mcEvents, debugLines, domain, port,
        /** Deliver an event to the handlers registered with AddEventDispatch (as MeshCentral's DispatchEvent does). */
        dispatch: function (ev) { for (const t of eventTargets.slice()) { if (t.HandleEvent) t.HandleEvent(null, ev, ['*'], '*'); } },
        client: function (defaults) { return new Client(port, defaults); },
        close: function () { core.close(); return new Promise(function (r) { server.close(r); }); }
    };
}

/** Minimal HTTP client with a cookie jar. */
class Client {
    constructor(port, defaults) { this.port = port; this.jar = {}; this.defaults = defaults || {}; }

    cookieHeader() { return Object.keys(this.jar).map((k) => k + '=' + this.jar[k]).join('; '); }

    request(method, path, opts) {
        opts = opts || {};
        const headers = Object.assign({ host: NAME }, this.defaults.headers || {}, opts.headers || {});
        let body = null;
        if (opts.json !== undefined) { body = JSON.stringify(opts.json); headers['content-type'] = headers['content-type'] || 'application/json'; }
        if (opts.raw !== undefined) { body = opts.raw; }
        if (body != null) headers['content-length'] = Buffer.byteLength(body);
        if ((opts.cookies !== false) && Object.keys(this.jar).length) headers.cookie = this.cookieHeader();
        if (opts.csrf) { headers['x-outband'] = '1'; headers.origin = ORIGIN; }
        if (opts.bearer) { headers.authorization = 'Bearer ' + opts.bearer; if (opts.tls !== false) headers['x-forwarded-proto'] = 'https'; }
        for (const k of Object.keys(headers)) { if (headers[k] === null) delete headers[k]; }
        const self = this;
        return new Promise(function (resolve, reject) {
            const req = http.request({ host: '127.0.0.1', port: self.port, method: method, path: path, headers: headers, agent: false }, function (res) {
                const chunks = [];
                res.on('data', function (c) { chunks.push(c); });
                res.on('end', function () {
                    const set = res.headers['set-cookie'] || [];
                    for (const c of set) {
                        const kv = c.split(';')[0]; const i = kv.indexOf('=');
                        const k = kv.substring(0, i), v = kv.substring(i + 1);
                        if ((v == '') || /expires=Thu, 01 Jan 1970/i.test(c)) delete self.jar[k]; else self.jar[k] = v;
                    }
                    const text = Buffer.concat(chunks).toString('utf8');
                    let json = null; try { json = text ? JSON.parse(text) : null; } catch (ex) { }
                    resolve({ status: res.statusCode, headers: res.headers, text: text, body: json });
                });
            });
            req.on('error', reject);
            if (body != null) req.write(body);
            req.end();
        });
    }
    get(p, o) { return this.request('GET', p, o); }
    post(p, o) { return this.request('POST', p, Object.assign({ csrf: true }, o || {})); }
    put(p, o) { return this.request('PUT', p, Object.assign({ csrf: true }, o || {})); }
    del(p, o) { return this.request('DELETE', p, Object.assign({ csrf: true }, o || {})); }

    async login(username, password) { return this.post('/api/v1/auth/login', { json: { username: username, password: password } }); }
}

module.exports = { start, NAME, ORIGIN, FULL };

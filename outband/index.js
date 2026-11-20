/**
 * @description Outband API: entry point. Wires the store, session records,
 * tokens, audit, limits and the /api/v1 router, and exposes the few hooks
 * MeshCentral's webserver calls.
 *
 * Hooks used by webserver.js (each call site is marked "Outband"):
 *   core.ready                     promise; the session middleware awaits it
 *   core.onNewSession(req)         from setSessionRandom: create the session record
 *   core.sessionValid(session)     from the session middleware
 *   core.checkAuthCookie(cookie[, sessionRequired])  from checkAuthCookie and the relay cookie checks
 *   core.onLogout(userid, x)       from the legacy logout handler
 *   core.router()                  mounted at /api/v1
 * @license Apache-2.0
 */

'use strict';

const EventEmitter = require('events');
const { readConfig } = require('./config');
const { openStore } = require('./store');
const { SessionRecords } = require('./sessions');
const { Tokens } = require('./tokens');
const { Audit } = require('./audit');
const { Pseudonyms } = require('./pseudonym');
const { RuntimeSettings } = require('./settings');
const { PendingLogins } = require('./pending');
const { Tickets } = require('./tickets');
const { Idempotency } = require('./idempotency');
const { NotBefore } = require('./notbefore');
const { WindowLimiter, FailureLock, ConcurrencyLimiter } = require('./ratelimit');
const { installDebugRedaction } = require('./redact');
const { createStubResources } = require('./resources');
const { revalidate } = require('./auth');
const twofa = require('./twofa');

/**
 * @param {object} webserver MeshCentral webserver object
 * @param {object} parent MeshCentral server object
 * @param {object} hooks closures from webserver.js: checkUserOneTimePasswordRequired, checkUserOneTimePassword, userHasSecondFactor, setSessionRandom
 * @param {{inMemory?: boolean, dir?: string}} [options]
 */
function create(webserver, parent, hooks, options) {
    options = options || {};
    const core = {
        webserver: webserver, parent: parent, hooks: hooks,
        config: readConfig(parent),
        bus: new EventEmitter(),
        state: 'starting', degraded: false,
        pending: new PendingLogins(),
        tickets: new Tickets(),
        resources: createStubResources(),
        timers: []
    };
    core.bus.setMaxListeners(0);
    const rl = core.config.rateLimits;
    core.limits = {
        perCredential: new WindowLimiter(rl.requestsPerMinute, 60000),
        action: new WindowLimiter(rl.powerPerMinute, 60000),
        device: new WindowLimiter(rl.devicePowerPerMinute, 60000),
        streams: new ConcurrencyLimiter(rl.streams),
        streamsTotal: new ConcurrencyLimiter(rl.streamsTotal),
        events: new WindowLimiter(rl.eventsPerMinute, 60000),
        health: new WindowLimiter(rl.healthPerMinute, 60000),
        invalidBearer: new FailureLock(rl.invalidBearer, rl.invalidBearerWindowMinutes * 60000, rl.invalidBearerWindowMinutes * 60000),
        account: new FailureLock(rl.accountFailures, rl.accountWindowMinutes * 60000, rl.accountWindowMinutes * 60000)
    };

    installDebugRedaction(parent);

    core.noAuthMode = function () { return (webserver.args.nousers === true) || ((typeof webserver.args.user == 'string') && (webserver.args.user.length > 0)); };
    /** The API is off (`outbandApi.enabled: false`), or the setup is not supported in this alpha (multi-server). */
    core.apiDisabled = function () { return (core.config.enabled === false) || (parent.multiServer != null) || (parent.config && parent.config.peers != null); };
    core.revalidate = function (ctx) { return revalidate(core, ctx); };
    core.setResources = function (impl) { core.resources = impl; };

    core.onNewSession = function (req) {
        if ((core.sessions != null) && req && req.session) core.sessions.onNewSession(req.session.userid, req.session.x);
    };
    core.sessionValid = function (session) { return (core.sessions == null) ? false : core.sessions.checkSession(session); };
    core.checkAuthCookie = function (cookie, sessionRequired) { return (core.sessions == null) ? false : core.sessions.checkAuthCookie(cookie, sessionRequired === true); };
    /** Legacy logout: persist the revocation and cancel the session's console tickets. */
    core.onLogout = function (userid, x) {
        if ((core.sessions == null) || (typeof userid != 'string') || (typeof x != 'string')) return;
        core.sessions.revoke(userid, x, 'logout').catch(function () { });
        core.tickets.cancelCredential('ses:' + userid + '/' + x);
    };

    let router = null;
    core.router = function () { if (router == null) { router = require('./router').buildRouter(core); } return router; };

    /** User deletion: erase per spec (tokens, session records, pending logins now; audit pseudonymized). */
    core.eraseUser = async function (userid) {
        await core.tokens.removeUser(userid);
        await core.notBefore.forget(userid);
        await core.sessions.revokeUser(userid, 'locked');
        core.pending.removeUser(userid);
        core.tickets.cancelUser(userid);
        await core.audit.eraseUser(userid, core.pseudonyms.erased(userid));
    };

    core.ready = (async function () {
        const store = await openStore({ inMemory: !!options.inMemory, dir: options.dir || parent.datapath });
        core.store = store;
        core.sessions = new SessionRecords(store, webserver, core.config, core.bus);
        core.tokens = new Tokens(store, core.bus);
        core.audit = new Audit(store, core.config);
        core.pseudonyms = new Pseudonyms(store);
        core.settings = new RuntimeSettings(store, core.config, core.bus);
        core.idempotency = new Idempotency(store);
        core.notBefore = new NotBefore(store, core.bus, function () { return webserver.users; });
        await core.notBefore.load();
        await core.pseudonyms.load();
        await core.settings.load();
        await core.sessions.load();
        await Promise.all([core.audit.purge(), core.tokens.purge(), core.idempotency.purge()]); // retention, also at startup
        // A credential change revokes the user's earlier tokens and sessions (listed as revoked).
        core.bus.on('credentials-changed', function (e) {
            core.tokens.revokeIssuedBefore(e.userid, e.notBefore, 'credentials_changed').catch(function () { });
            for (const r of Array.from(core.sessions.records.values())) { if ((r.u == e.userid) && (r.ia < e.notBefore)) core.sessions.revoke(r.u, r.x, 'expired'); }
        });
        if (!options.noTimers) {
            core.settings.start();
            core.notBefore.start(function () { return webserver.users; });
            const every = function (ms, fn) { const t = setInterval(fn, ms); if (t.unref) t.unref(); core.timers.push(t); };
            every(60000, function () { core.sessions.sweep(); });
            every(3600000, function () { core.audit.purge(); core.tokens.purge(); core.idempotency.purge(); });
        }
        if ((typeof parent.AddEventDispatch == 'function')) {
            parent.AddEventDispatch(['*'], {
                HandleEvent: function (source, event) {
                    if ((event != null) && (event.action == 'accountremove') && (typeof event.userid == 'string')) { core.eraseUser(event.userid).catch(function () { }); }
                }
            });
        }
        if (parent.config && parent.config.domains) {
            for (const id of Object.keys(parent.config.domains)) {
                const d = parent.config.domains[id];
                if (!twofa.available(core, d)) {
                    const msg = 'Outband API: two-factor login is not available in this configuration' + (id ? (' (domain ' + id + ')') : '') + '; /api/v1/server reports features.twofa.available=false.';
                    if (typeof parent.addServerWarning == 'function') parent.addServerWarning(msg); else console.log('WARNING: ' + msg);
                }
            }
        }
        core.setResources(Object.assign(createStubResources(), require('./devices')(core)));
        core.state = 'ready';
    })().catch(function (err) {
        core.state = 'failed';
        console.log('Outband API failed to start: ' + (err && err.message));
    });

    core.close = function () {
        core.bus.emit('shutdown');
        if (core.hub && core.hub.handler && (typeof parent.RemoveEventDispatch == 'function')) { try { parent.RemoveEventDispatch(['*'], core.hub.handler); } catch (ex) { } }
        if (core.audit) core.audit.onWrite = null;
 if (core.settings) core.settings.stop(); if (core.notBefore) core.notBefore.stop(); if (core.store) core.store.close(); for (const t of core.timers) clearInterval(t); core.timers = []; };
    return core;
}

module.exports = { create };

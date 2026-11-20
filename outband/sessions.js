/**
 * @description Outband API: server-side session records and the revocation list.
 *
 * Every MeshCentral web session has a record keyed by `<userid>/<session id>`:
 *   ia      issue time (ms), written once
 *   la      last real password check (ms) or null, written by the login handler
 *   la2     last real second-factor check (ms) or null
 * Rules (applied to every endpoint through the hooks in webserver.js):
 *   no record => expired; ia older than the lifetime => expired; revoked => expired.
 * Records live in memory for the synchronous checks and are persisted.
 * @license Apache-2.0
 */

'use strict';

function key(userid, x) { return userid + '/' + x; }

class SessionRecords {
    /**
     * @param {object} store Outband store
     * @param {object} webserver MeshCentral webserver (for destroyedSessions)
     * @param {{sessionLifetimeMs: number}} config
     * @param {import('events').EventEmitter} bus
     */
    constructor(store, webserver, config, bus) {
        this.store = store; this.webserver = webserver; this.config = config; this.bus = bus;
        this.records = new Map(); // key -> {u, x, ia, la, la2}
        this.revoked = new Map(); // key -> exp
        this.loaded = false;
    }

    lifetime() { return this.config.sessionLifetimeMs; }

    async load() {
        const now = Date.now();
        await this.store.sessions.remove({ ia: { $lt: now - this.lifetime() } });
        await this.store.revocations.remove({ exp: { $lt: now } });
        for (const r of await this.store.sessions.find({})) { this.records.set(r.k, { u: r.u, x: r.x, ia: r.ia, la: r.la || null, la2: r.la2 || null }); }
        for (const r of await this.store.revocations.find({})) {
            this.revoked.set(r.k, r.exp);
            this.records.delete(r.k);
            if (this.webserver && this.webserver.destroyedSessions) { this.webserver.destroyedSessions[r.k] = now; }
        }
        this.loaded = true;
    }

    _persist(k) {
        const r = this.records.get(k);
        if (r == null) return Promise.resolve();
        return this.store.sessions.upsert({ k: k }, { k: k, u: r.u, x: r.x, ia: r.ia, la: r.la, la2: r.la2 }).catch(function () { });
    }

    /** Called when MeshCentral gives a session its random id (every login path). */
    onNewSession(userid, x) {
        if ((typeof userid != 'string') || (typeof x != 'string')) return;
        const k = key(userid, x);
        if (this.records.has(k) || this.revoked.has(k)) return;
        this.records.set(k, { u: userid, x: x, ia: Date.now(), la: null, la2: null });
        this._persist(k);
    }

    get(userid, x) {
        if ((typeof userid != 'string') || (typeof x != 'string')) return null;
        const k = key(userid, x);
        if (this.revoked.has(k)) return null;
        const r = this.records.get(k);
        if (r == null) return null;
        if ((Date.now() - r.ia) >= this.lifetime()) return null;
        return r;
    }

    isValid(userid, x) { return this.get(userid, x) != null; }

    /** Session-object check used by the session middleware. */
    checkSession(session) {
        if ((session == null) || (typeof session.userid != 'string')) return true; // no user, nothing to check
        if (typeof session.x != 'string') return false;
        return this.isValid(session.userid, session.x);
    }

    /** Auth-cookie check: cookies derived from a session stop working when it expires. */
    checkAuthCookie(cookie) {
        if ((cookie == null) || (cookie.x == null)) return true; // not derived from a web session
        const userid = (typeof cookie.userid == 'string') ? cookie.userid : cookie.ruserid;
        if (typeof userid != 'string') return false;
        return this.isValid(userid, String(cookie.x));
    }

    /** Written by the login handler after a real check. */
    markAuth(userid, x, passwordTime, secondFactorTime) {
        const r = this.records.get(key(userid, x));
        if (r == null) return Promise.resolve();
        if (passwordTime != null) { r.la = passwordTime; }
        if (secondFactorTime != null) { r.la2 = secondFactorTime; }
        return this._persist(key(userid, x));
    }

    /** Put a session on the persisted revocation list. */
    async revoke(userid, x, reason) {
        if ((typeof userid != 'string') || (typeof x != 'string')) return;
        const k = key(userid, x);
        const r = this.records.get(k);
        const exp = ((r != null) ? r.ia : Date.now()) + this.lifetime() + 3600000;
        this.records.delete(k);
        this.revoked.set(k, exp);
        if (this.webserver && this.webserver.destroyedSessions) { this.webserver.destroyedSessions[k] = Date.now(); }
        this.bus.emit('session-ended', { userid: userid, x: x, reason: reason || 'logout' });
        await this.store.sessions.remove({ k: k }).catch(function () { });
        await this.store.revocations.upsert({ k: k }, { k: k, exp: exp }).catch(function () { });
    }

    /** Revoke every session of a user (deletion, lock). */
    async revokeUser(userid, reason) {
        const list = [];
        for (const r of this.records.values()) { if (r.u == userid) { list.push(r.x); } }
        for (const x of list) { await this.revoke(userid, x, reason); }
    }

    /** Expire sessions past their lifetime, prune old revocations. Runs every minute. */
    async sweep() {
        const now = Date.now();
        for (const [k, r] of this.records) {
            if ((now - r.ia) >= this.lifetime()) {
                this.records.delete(k);
                if (this.webserver && this.webserver.destroyedSessions) { this.webserver.destroyedSessions[k] = now; }
                this.bus.emit('session-ended', { userid: r.u, x: r.x, reason: 'expired' });
                await this.store.sessions.remove({ k: k }).catch(function () { });
            }
        }
        for (const [k, exp] of this.revoked) {
            if (exp < now) { this.revoked.delete(k); }
            else if (this.webserver && this.webserver.destroyedSessions && (this.webserver.destroyedSessions[k] == null)) { this.webserver.destroyedSessions[k] = now; }
        }
        await this.store.revocations.remove({ exp: { $lt: now } }).catch(function () { });
    }
}

module.exports = { SessionRecords, sessionKey: key };

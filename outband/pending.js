/**
 * @description Outband API: pending two-factor logins.
 *
 * The browser cookie carries only an opaque random id and its expiry. All
 * other state lives here, in memory, with an expiry of at most 5 minutes and
 * a size cap. No username or password is stored.
 * @license Apache-2.0
 */

'use strict';

const crypto = require('crypto');
const { FailureLock } = require('./ratelimit');

const PENDING_MS = 5 * 60000;
const MAX_PENDING = 10000;
const MAX_FAILS_PER_PENDING = 5;
const SEND_INTERVAL_MS = 60000;
const MAX_SENDS_PER_PENDING = 5;
const MAX_SENDS_PER_USER_HOUR = 10;

class PendingLogins {
    constructor() {
        this.map = new Map(); // id -> {id, userid, domainid, exp, fails, sends, lastSend, passwordTime, methods}
        this.userCodeLock = new FailureLock(10, 15 * 60000, 15 * 60000); // per user id, across pending logins
        this.userSends = new Map(); // userid -> [times]
    }

    create(userid, domainid, passwordTime, methods) {
        const now = Date.now();
        this.prune(now);
        if (this.map.size >= MAX_PENDING) { const oldest = this.map.keys().next().value; this.map.delete(oldest); }
        const id = crypto.randomBytes(24).toString('base64url');
        const p = { id: id, userid: userid, domainid: domainid, exp: now + PENDING_MS, fails: 0, sends: 0, lastSend: 0, passwordTime: passwordTime, methods: methods };
        this.map.set(id, p);
        return p;
    }

    /** A pending re-authentication, attached to an existing session (keyed by `<userid>/<x>`). */
    createReauth(sessionKey, userid, domainid, passwordTime, methods) {
        const now = Date.now();
        this.prune(now);
        const id = 'reauth:' + sessionKey;
        const p = { id: id, userid: userid, domainid: domainid, exp: now + PENDING_MS, fails: 0, sends: 0, lastSend: 0, passwordTime: passwordTime, methods: methods };
        this.map.set(id, p); // a new step 1 replaces the previous one
        return p;
    }

    getReauth(sessionKey) { return this.get('reauth:' + sessionKey); }

    get(id) {
        if (typeof id != 'string') return null;
        const p = this.map.get(id);
        if (p == null) return null;
        if (p.exp <= Date.now()) { this.map.delete(id); return null; }
        return p;
    }

    discard(id) { this.map.delete(id); }

    removeUser(userid) { for (const [id, p] of this.map) { if (p.userid == userid) this.map.delete(id); } }

    /** Seconds the user is barred from second-factor checks, or 0. */
    userLockedFor(userid) { return this.userCodeLock.lockedFor(userid); }

    /** Record a wrong code. Returns true when the pending login was discarded. */
    wrongCode(p) {
        this.userCodeLock.fail(p.userid);
        p.fails++;
        if (p.fails >= MAX_FAILS_PER_PENDING) { this.map.delete(p.id); return true; }
        return false;
    }

    /** Check the code-send limits; on success record the send. Returns 0 or seconds to wait. */
    trySend(p) {
        const now = Date.now();
        if (p.sends >= MAX_SENDS_PER_PENDING) return Math.max(1, Math.ceil((p.exp - now) / 1000));
        if (now - p.lastSend < SEND_INTERVAL_MS) return Math.ceil((SEND_INTERVAL_MS - (now - p.lastSend)) / 1000);
        const times = (this.userSends.get(p.userid) || []).filter(function (t) { return t > now - 3600000; });
        if (times.length >= MAX_SENDS_PER_USER_HOUR) return Math.ceil((times[0] + 3600000 - now) / 1000);
        times.push(now);
        this.userSends.set(p.userid, times);
        if (this.userSends.size > MAX_PENDING) { this.userSends.clear(); this.userSends.set(p.userid, times); }
        p.sends++; p.lastSend = now;
        return 0;
    }

    prune(now) { for (const [id, p] of this.map) { if (p.exp <= now) this.map.delete(id); } }
}

module.exports = { PendingLogins, PENDING_MS };

/**
 * @description Outband API: per-user `not_before` times.
 *
 * Sessions and tokens issued before a user's `not_before` are refused.
 * `not_before` advances only on a real credential change: a new password
 * (MeshCentral sets `passchange` to the current time whenever a password is
 * set, by the user, an administrator, a reset link or the command line), or a
 * "change at next login" reset (`passchange` = -1), including a user first
 * seen while a reset is pending. Lock state is checked separately on
 * every request (see auth.js).
 *
 * The stored credential state is derived from `passchange` only, never from
 * the hash bytes: MeshCentral re-encodes a stored hash (new salt, algorithm
 * or iteration count) for the same password, for example when it upgrades a
 * legacy hash format on login, and that must not end the user's sessions or
 * tokens. The state is checked on every authenticated request and by a
 * periodic sweep over MeshCentral's user table, and persisted in Outband's
 * store.
 * @license Apache-2.0
 */

'use strict';

const crypto = require('crypto');

const SWEEP_MS = 15000;
const PREFIX = 'pc:'; // current state format: 'pc:<passchange seconds>', 'pc:reset' or 'pc:0'

/**
 * The user's `passchange` as whole seconds: -1 for a "change at next login"
 * reset, 0 when never set. Millisecond values (older databases) are normalized.
 */
function passchangeSeconds(user) {
    const pc = user.passchange;
    if (pc === -1) return -1;
    if ((typeof pc != 'number') || !isFinite(pc) || (pc <= 0)) return 0;
    return Math.floor((pc > 1300000000000) ? (pc / 1000) : pc);
}

/** Credential state of a user record. Changes only when a password is set or a reset is requested. */
function fingerprint(user) {
    const pc = passchangeSeconds(user);
    return PREFIX + ((pc === -1) ? 'reset' : String(pc));
}

/** Parse a stored state; null for the earlier hash-based format. */
function parseState(fp) {
    if ((typeof fp != 'string') || !fp.startsWith(PREFIX)) return null;
    const v = fp.substring(PREFIX.length);
    if (v === 'reset') return -1;
    const n = parseInt(v, 10);
    return isFinite(n) ? n : 0;
}

/**
 * True when moving from state `prev` to `cur` is a credential change: a reset
 * requested, `passchange` set to a different positive value, or a positive
 * `passchange` removed (fail closed). A backward move counts too, so a new
 * password stamped by a server with a clock behind is not missed.
 */
function isCredentialChange(prev, cur) {
    if (cur === -1) return (prev !== -1); // reset requested
    if (cur === 0) return (prev > 0); // a positive passchange removed: fail closed
    return (cur !== prev); // a new password (including out of a reset)
}

/** The earlier stored format (hash of salt, hash, passtype and the reset flag), used once to migrate. */
function legacyFingerprint(user) {
    const reset = (user.passchange === -1) ? 'reset' : '';
    return crypto.createHash('sha256').update(String(user.salt || '') + '\u0000' + String(user.hash || '') + '\u0000' + String(user.passtype || '') + '\u0000' + reset).digest('base64');
}

class NotBefore {
    constructor(store, bus) { this.store = store; this.bus = bus; this.map = new Map(); this.timer = null; } // userid -> {fp, nb}

    async load() {
        for (const d of await this.store.userstate.find({})) { this.map.set(d._id, { fp: d.fp, nb: d.nb || 0 }); }
    }

    _save(userid, rec) { return this.store.userstate.upsert({ _id: userid }, { _id: userid, fp: rec.fp, nb: rec.nb }).catch(function () { }); }

    _advance(userid, rec, fp) {
        rec.fp = fp;
        rec.nb = Date.now();
        this._save(userid, rec);
        this.bus.emit('credentials-changed', { userid: userid, notBefore: rec.nb });
    }

    /**
     * Observe a user record. Records a baseline the first time; sets
     * `not_before` to now on a credential change.
     * @returns {number} the effective not_before (ms)
     */
    observe(user) {
        if ((user == null) || (typeof user._id != 'string')) return 0;
        const fp = fingerprint(user);
        const cur = parseState(fp);
        let rec = this.map.get(user._id);
        if (rec == null) {
            rec = { fp: fp, nb: 0 };
            this.map.set(user._id, rec);
            if (cur === -1) { this._advance(user._id, rec, fp); } else { this._save(user._id, rec); } // first seen mid-reset: nothing issued earlier stays valid
        } else if (rec.fp != fp) {
            const prev = parseState(rec.fp);
            if (prev === null) {
                // Stored in the earlier format. Adopt the current state without revoking anything,
                // except a reset requested since that record was written. A password set since then
                // is still enforced through passchange below.
                const resetSince = (cur === -1) && (rec.fp != legacyFingerprint(user));
                if (resetSince) { this._advance(user._id, rec, fp); } else { rec.fp = fp; this._save(user._id, rec); }
            } else if (isCredentialChange(prev, cur)) {
                this._advance(user._id, rec, fp);
            } else {
                rec.fp = fp; // a reset flag cleared without a new password: no change of credential
                this._save(user._id, rec);
            }
        }
        const pc = passchangeSeconds(user);
        return Math.max(rec.nb, (pc > 0) ? (pc * 1000) : 0);
    }

    /** Sweep MeshCentral's in-memory user table (catches changes made outside the API). */
    sweep(users) { for (const id of Object.keys(users || {})) { const u = users[id]; if (u && (u.type == 'user')) this.observe(u); } }

    start(getUsers) {
        if (this.timer != null) return;
        this.sweep(getUsers());
        this.timer = setInterval(() => { this.sweep(getUsers()); }, SWEEP_MS);
        if (this.timer.unref) this.timer.unref();
    }
    stop() { if (this.timer != null) { clearInterval(this.timer); this.timer = null; } }

    forget(userid) { this.map.delete(userid); return this.store.userstate.remove({ _id: userid }).catch(function () { }); }
}

module.exports = { NotBefore, fingerprint, legacyFingerprint, isCredentialChange };

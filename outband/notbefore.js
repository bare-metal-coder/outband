/**
 * @description Outband API: per-user `not_before` times.
 *
 * Sessions and tokens issued before a user's `not_before` are refused.
 * Outband sets it whenever it sees the user's password credential change,
 * or a "change at next login" reset, whoever made the change (the user, an
 * administrator, a reset link or a tool). Changes are detected by a
 * fingerprint of the stored credential, checked on every authenticated
 * request and by a periodic sweep over MeshCentral's user table. The value
 * is persisted in Outband's store.
 * @license Apache-2.0
 */

'use strict';

const crypto = require('crypto');

const SWEEP_MS = 15000;

/** Fingerprint of the parts of a user record that change on a password change or reset. */
function fingerprint(user) {
    const reset = (user.passchange === -1) ? 'reset' : '';
    return crypto.createHash('sha256').update(String(user.salt || '') + '\u0000' + String(user.hash || '') + '\u0000' + String(user.passtype || '') + '\u0000' + reset).digest('base64');
}

class NotBefore {
    constructor(store, bus) { this.store = store; this.bus = bus; this.map = new Map(); this.timer = null; } // userid -> {fp, nb}

    async load() {
        for (const d of await this.store.userstate.find({})) { this.map.set(d._id, { fp: d.fp, nb: d.nb || 0 }); }
    }

    _save(userid, rec) { return this.store.userstate.upsert({ _id: userid }, { _id: userid, fp: rec.fp, nb: rec.nb }).catch(function () { }); }

    /**
     * Observe a user record. Records a baseline the first time; sets
     * `not_before` to now when the credential fingerprint changes.
     * @returns {number} the effective not_before (ms)
     */
    observe(user) {
        if ((user == null) || (typeof user._id != 'string')) return 0;
        const fp = fingerprint(user);
        let rec = this.map.get(user._id);
        if (rec == null) {
            rec = { fp: fp, nb: 0 };
            this.map.set(user._id, rec);
            this._save(user._id, rec);
        } else if (rec.fp != fp) {
            rec.fp = fp;
            rec.nb = Date.now();
            this._save(user._id, rec);
            this.bus.emit('credentials-changed', { userid: user._id, notBefore: rec.nb });
        }
        const pc = ((typeof user.passchange == 'number') && (user.passchange > 0)) ? (user.passchange * 1000) : 0;
        return Math.max(rec.nb, pc);
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

module.exports = { NotBefore, fingerprint };

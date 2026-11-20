/**
 * @description Outband API: audit events.
 *
 * Outband writes its own persisted audit records, in its own collection,
 * with its own retention (`outbandApi.auditRetentionDays`, default 365).
 * Denials are aggregated: at most one record per credential, reason and
 * minute, with a count.
 *
 * Stored record:
 *   _id 'evt_…', time (ms), domain, type ('user'|'node'|'mesh'|'server'),
 *   action ('outband.login', …), outcome ('success'|'denied'|'failed'),
 *   user (full user id or null), user_name, token_id, token_name,
 *   device_id, group_id (full ids or null), action_id, source_ip,
 *   reason, params (typed template parameters), count
 * @license Apache-2.0
 */

'use strict';

const { randomId, truncateIp } = require('./util');

/** Message templates by action. Parameters are typed; free text is never passed through. */
const TEMPLATES = {
    'outband.login': { success: 'Logged in', failed: 'Login failed', denied: 'Login refused' },
    'outband.2fa': { success: 'Second factor accepted', failed: 'Second factor rejected', denied: 'Second factor refused' },
    'outband.reauth': { success: 'Re-authenticated', failed: 'Re-authentication failed' },
    'outband.logout': { success: 'Logged out' },
    'outband.token.create': { success: 'API token created' },
    'outband.token.revoke': { success: 'API token revoked' },
    'outband.token.use_ended': { denied: 'Use of a revoked or expired API token' },
    'outband.settings.bearer': { success: 'Bearer authentication turned {state}' },
    'outband.csrf': { denied: 'Request refused by the CSRF check' },
    'outband.power': { success: 'Power action "{power_action}" dispatched through {path}', denied: 'Power action "{power_action}" denied' },
    'outband.console.ticket': { success: 'Console ticket issued ({kind})', denied: 'Console ticket denied ({kind})' },
    'outband.console.open': { success: 'Console opened ({kind})', denied: 'Console open refused ({kind})' },
    'outband.not_found': { denied: 'Device not found' }
};

const SAFE_PARAM = /^[A-Za-z0-9 ._:\/-]{0,64}$/;

class Audit {
    constructor(store, config) {
        this.store = store; this.config = config;
        this.agg = new Map(); // credential|reason|minute -> {id, count}
    }

    /**
     * Write one audit record.
     * @param {object} e {domain, type, action, outcome, user, userName, tokenId, tokenName, deviceId, groupId, actionId, ip, reason, params}
     */
    async write(e) {
        const params = {};
        if (e.params) { for (const k of Object.keys(e.params)) { const v = e.params[k]; if ((typeof v == 'string' && SAFE_PARAM.test(v)) || typeof v == 'number' || typeof v == 'boolean') params[k] = v; } }
        const doc = {
            _id: randomId('evt_', 12), time: Date.now(), domain: e.domain || '',
            type: e.type || 'user', action: e.action, outcome: e.outcome || 'success',
            user: e.user || null, user_name: e.userName || null,
            token_id: e.tokenId || null, token_name: e.tokenName || null,
            device_id: e.deviceId || null, group_id: e.groupId || null,
            action_id: e.actionId || null, source_ip: e.ip || null,
            reason: e.reason || null, params: params, count: 1
        };
        try { await this.store.audit.insert(doc); } catch (ex) { }
        return doc;
    }

    /** Aggregated denial: one record per credential, reason and minute. */
    async deny(credentialKey, e) {
        const minute = Math.floor(Date.now() / 60000);
        const k = (credentialKey || ('ip:' + (e.ip || ''))) + '|' + (e.action || '') + '|' + (e.reason || '') + '|' + minute;
        const hit = this.agg.get(k);
        if (hit != null) {
            hit.count++;
            this.store.audit.update({ _id: hit.id }, { $set: { count: hit.count } }).catch(function () { });
            return;
        }
        if (this.agg.size > 10000) { for (const key of this.agg.keys()) { if (!key.endsWith('|' + minute)) this.agg.delete(key); } if (this.agg.size > 10000) this.agg.clear(); }
        const doc = await this.write(Object.assign({}, e, { outcome: 'denied' }));
        this.agg.set(k, { id: doc._id, count: 1 });
    }

    /** Remove events past retention. */
    purge() {
        const cutoff = Date.now() - (this.config.auditRetentionDays * 86400000);
        return this.store.audit.remove({ time: { $lt: cutoff } }).catch(function () { });
    }

    /** Erasure: keep events, replace the name, pseudonymize the id, truncate source_ip. */
    async eraseUser(userid, pseudonym) {
        const docs = await this.store.audit.find({ user: userid });
        for (const d of docs) {
            await this.store.audit.update({ _id: d._id }, { $set: { user: pseudonym, user_name: 'deleted user', erased: true, source_ip: truncateIp(d.source_ip) } }).catch(function () { });
        }
    }

    /** Query helper for event endpoints: newest first, paged by (time, _id). */
    async find(query, limit, cursor) {
        const q = Object.assign({}, query);
        if (cursor != null) { q.$or = [{ time: { $lt: cursor.t } }, { time: cursor.t, _id: { $lt: cursor.i } }]; }
        const docs = await this.store.audit.find(q, { sort: { time: -1, _id: -1 }, limit: limit + 1 });
        const more = docs.length > limit;
        const items = docs.slice(0, limit);
        const last = items[items.length - 1];
        return { items: items, next: (more && last) ? { t: last.time, i: last._id } : null };
    }

    /** The allowlisted message for a stored audit record. */
    static message(doc) {
        const t = TEMPLATES[doc.action];
        const tpl = (t && (t[doc.outcome] || t.success)) || 'Audit event';
        return tpl.replace(/\{([a-z_]+)\}/g, function (m, k) { const v = doc.params && doc.params[k]; return (v == null) ? '' : String(v); });
    }
}

module.exports = { Audit, TEMPLATES };

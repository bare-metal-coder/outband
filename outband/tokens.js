/**
 * @description Outband API: API tokens (`obt_<secret>`).
 * Only sha256(secret) is stored; lookups go through a unique index on it.
 * @license Apache-2.0
 */

'use strict';

const crypto = require('crypto');
const { randomId, sha256Hex, safeEqual, iso, lastSegment, ApiError } = require('./util');

const SCOPES = ['read', 'power_on', 'power_off', 'console', 'identity', 'audit'];
const PROFILES = { device_power: ['read', 'power_on', 'power_off'] };
const MAX_LIVE_TOKENS = 50;
const KEEP_AFTER_END_MS = 30 * 86400000;
const SECRET_RE = /^obt_[A-Za-z0-9_-]{43}$/;

/** Maximum lifetime in days for a set of scopes. */
function maxLifetimeDays(scopes) {
    if (scopes.indexOf('console') >= 0) return 30;
    if ((scopes.indexOf('power_on') >= 0) || (scopes.indexOf('power_off') >= 0) || (scopes.indexOf('audit') >= 0)) return 90;
    return 365;
}

/** Scopes other than these need step-up at creation. */
function needsStepUp(scopes) { return scopes.some(function (s) { return (s != 'read') && (s != 'identity'); }); }

class Tokens {
    constructor(store, bus) { this.store = store; this.bus = bus; this.lastUsedWrites = new Map(); }

    /** @returns {Promise<{doc: object, secret: string}>} */
    async create(opts) {
        const secret = 'obt_' + crypto.randomBytes(32).toString('base64url'); // 43 chars
        const now = Date.now();
        const doc = {
            _id: randomId('tok_', 16),
            h: sha256Hex(secret),
            prefix: secret.substring(0, 8),
            name: opts.name,
            owner: opts.owner,
            domain: opts.domain,
            scopes: opts.scopes,
            groups: opts.groups || null,
            allowed_ips: opts.allowedIps || null,
            created: now,
            expires: now + (opts.days * 86400000),
            last_used: null,
            revoked: null,
            revoked_by: null
        };
        await this.store.tokens.insert(doc);
        return { doc: doc, secret: secret };
    }

    /** Find a token by its secret. Returns the stored doc or null. */
    async findBySecret(secret) {
        if ((typeof secret != 'string') || !SECRET_RE.test(secret)) return null;
        const h = sha256Hex(secret);
        const doc = await this.store.tokens.findOne({ h: h });
        if ((doc == null) || !safeEqual(doc.h, h)) return null;
        return doc;
    }

    get(id) { return this.store.tokens.findOne({ _id: id }); }

    liveCount(owner) { return this.store.tokens.count({ owner: owner, revoked: null, expires: { $gt: Date.now() } }); }

    touch(doc) {
        const now = Date.now();
        const last = this.lastUsedWrites.get(doc._id) || 0;
        if (now - last < 60000) return;
        this.lastUsedWrites.set(doc._id, now);
        if (this.lastUsedWrites.size > 10000) { this.lastUsedWrites.clear(); }
        this.store.tokens.update({ _id: doc._id }, { $set: { last_used: now } }).catch(function () { });
    }

    async revoke(doc, byUserId, reason) {
        if (doc.revoked == null) {
            const now = Date.now();
            await this.store.tokens.update({ _id: doc._id }, { $set: { revoked: now, revoked_by: byUserId } });
            doc.revoked = now;
        }
        this.bus.emit('token-ended', { tokenId: doc._id, reason: reason || 'revoked' });
    }

    /** Delete every token of a user (erasure). */
    async removeUser(userid) {
        const docs = await this.store.tokens.find({ owner: userid });
        await this.store.tokens.remove({ owner: userid });
        for (const d of docs) { this.bus.emit('token-ended', { tokenId: d._id, reason: 'revoked' }); }
    }

    /**
     * Page through tokens, newest first.
     * @param {object} query NeDB query
     * @param {{limit: number, cursor: object|null}} page
     */
    async list(query, page) {
        const q = Object.assign({}, query);
        if (page.cursor != null) {
            if ((typeof page.cursor.c != 'number') || (typeof page.cursor.i != 'string')) { throw new ApiError(400, 'invalid_request', 'Invalid cursor', { field: 'cursor' }); }
            q.$or = [{ created: { $lt: page.cursor.c } }, { created: page.cursor.c, _id: { $lt: page.cursor.i } }];
        }
        const docs = await this.store.tokens.find(q, { sort: { created: -1, _id: -1 }, limit: page.limit + 1 });
        const more = docs.length > page.limit;
        const items = docs.slice(0, page.limit);
        const last = items[items.length - 1];
        return { items: items, next: (more && last) ? { c: last.created, i: last._id } : null };
    }

    /** Visible in lists: live, or ended less than 30 days ago. */
    static listableQuery() {
        const cutoff = Date.now() - KEEP_AFTER_END_MS;
        return { $and: [{ expires: { $gt: cutoff } }, { $or: [{ revoked: null }, { revoked: { $gt: cutoff } }] }] };
    }

    /** Remove token rows 30 days after expiry or revocation. */
    purge() {
        const cutoff = Date.now() - KEEP_AFTER_END_MS;
        return this.store.tokens.remove({ $or: [{ expires: { $lt: cutoff } }, { revoked: { $lt: cutoff } }] }).catch(function () { });
    }

    /** Spec `ApiToken` object, field by field. */
    static toApi(doc, ownerName) {
        return {
            id: doc._id,
            name: doc.name,
            owner: { id: lastSegment(doc.owner), name: ownerName || lastSegment(doc.owner) },
            prefix: doc.prefix,
            scopes: doc.scopes.slice(),
            groups: (doc.groups == null) ? null : doc.groups.slice(),
            allowed_ips: (doc.allowed_ips == null) ? null : doc.allowed_ips.slice(),
            created_at: iso(doc.created),
            expires_at: iso(doc.expires),
            last_used_at: iso(doc.last_used),
            revoked_at: iso(doc.revoked)
        };
    }
}

module.exports = { Tokens, SCOPES, PROFILES, MAX_LIVE_TOKENS, maxLifetimeDays, needsStepUp, SECRET_RE };

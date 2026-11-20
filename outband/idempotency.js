/**
 * @description Outband API: idempotency keys (24 hours), per credential.
 * @license Apache-2.0
 */

'use strict';

const { sha256Hex } = require('./util');

const KEEP_MS = 24 * 3600000;
const KEY_RE = /^[\x21-\x7E]{8,128}$/;

class Idempotency {
    constructor(store) { this.store = store; }

    static validKey(k) { return (typeof k == 'string') && KEY_RE.test(k); }

    _id(credentialKey, key, scope) { return sha256Hex(credentialKey + '\u0000' + scope + '\u0000' + key); }

    /**
     * Look up a stored result.
     * @returns {Promise<null|{conflict: true}|{status: number, body: object}>}
     */
    async lookup(credentialKey, key, scope, requestBody) {
        const doc = await this.store.idempotency.findOne({ _id: this._id(credentialKey, key, scope) });
        if ((doc == null) || (doc.time < Date.now() - KEEP_MS)) return null;
        if (doc.req != sha256Hex(JSON.stringify(requestBody || null))) return { conflict: true };
        return { status: doc.status, body: doc.body };
    }

    save(credentialKey, key, scope, requestBody, status, body) {
        const id = this._id(credentialKey, key, scope);
        return this.store.idempotency.upsert({ _id: id }, { _id: id, time: Date.now(), req: sha256Hex(JSON.stringify(requestBody || null)), status: status, body: body }).catch(function () { });
    }

    purge() { return this.store.idempotency.remove({ time: { $lt: Date.now() - KEEP_MS } }).catch(function () { }); }
}

module.exports = { Idempotency };

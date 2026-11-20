/**
 * @description Outband API: idempotency keys (24 hours), per credential.
 * @license Apache-2.0
 */

'use strict';

const { sha256Hex } = require('./util');

const KEEP_MS = 24 * 3600000;
const KEY_RE = /^[\x21-\x7E]{8,128}$/;

class Idempotency {
    constructor(store) { this.store = store; this.inflight = new Map(); } // id -> promise of the request holding the key

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

    /**
     * Run `fn` at most once per (credential, key, scope). The key is reserved
     * synchronously before anything is awaited, so a concurrent request with the
     * same key waits for the first one and then gets its stored result (or 409
     * for another body). If the first request fails, nothing was stored and the
     * next one runs.
     * @param {function(): Promise<object>} fn  resolves to the response body
     * @returns {Promise<{status: number, body: object}|{conflict: true}>}
     */
    async run(credentialKey, key, scope, requestBody, status, fn) {
        const id = this._id(credentialKey, key, scope);
        for (;;) {
            const busy = this.inflight.get(id);
            if (busy == null) break;
            await busy.catch(function () { });
        }
        let done; const marker = new Promise(function (resolve) { done = resolve; });
        this.inflight.set(id, marker);
        try {
            const prev = await this.lookup(credentialKey, key, scope, requestBody);
            if (prev) return prev;
            const body = await fn();
            await this.save(credentialKey, key, scope, requestBody, status, body);
            return { status: status, body: body };
        } finally {
            if (this.inflight.get(id) === marker) this.inflight.delete(id);
            done();
        }
    }

    purge() { return this.store.idempotency.remove({ time: { $lt: Date.now() - KEEP_MS } }).catch(function () { }); }
}

module.exports = { Idempotency };

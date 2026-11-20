/**
 * @description Outband API: persistent store.
 *
 * Outband keeps its records (session records, the revocation list, API
 * tokens, audit events, runtime settings, idempotency keys, per-user
 * not_before) in its own
 * collections, separate from MeshCentral's database and its event expiry.
 * This implementation uses NeDB files in the MeshCentral data directory
 * (`outband-<name>.db`, mode 0600), or memory only for tests.
 * @license Apache-2.0
 */

'use strict';

const path = require('path');
const Datastore = require('@seald-io/nedb');

const COLLECTIONS = ['sessions', 'revocations', 'tokens', 'audit', 'settings', 'idempotency', 'userstate'];
/** Files are readable by the server account only. */
const MODES = { fileMode: 0o600, dirMode: 0o700 };

class Collection {
    constructor(ds) { this.ds = ds; }
    insert(doc) { return this.ds.insertAsync(doc); }
    findOne(q) { return this.ds.findOneAsync(q); }
    find(q, opts) {
        let c = this.ds.findAsync(q || {});
        if (opts && opts.sort) { c = c.sort(opts.sort); }
        if (opts && opts.limit) { c = c.limit(opts.limit); }
        return c;
    }
    count(q) { return this.ds.countAsync(q || {}); }
    update(q, upd, opts) { return this.ds.updateAsync(q, upd, opts || {}); }
    upsert(q, doc) { return this.ds.updateAsync(q, doc, { upsert: true }); }
    remove(q, opts) { return this.ds.removeAsync(q, opts || { multi: true }); }
}

/**
 * @param {{dir?: string, inMemory?: boolean}} options
 * @returns {Promise<Object<string, Collection>>}
 */
async function openStore(options) {
    const store = {};
    for (const name of COLLECTIONS) {
        const opts = options.inMemory ? { inMemoryOnly: true } : { filename: path.join(options.dir, 'outband-' + name + '.db'), modes: MODES };
        const ds = new Datastore(opts);
        await ds.loadDatabaseAsync();
        if (!options.inMemory) { ds.setAutocompactionInterval(3600000); }
        store[name] = new Collection(ds);
    }
    await store.tokens.ds.ensureIndexAsync({ fieldName: 'h', unique: true });
    await store.tokens.ds.ensureIndexAsync({ fieldName: 'owner' });
    await store.audit.ds.ensureIndexAsync({ fieldName: 'time' });
    await store.sessions.ds.ensureIndexAsync({ fieldName: 'k', unique: true });
    Object.defineProperty(store, 'close', { enumerable: false, value: function () { for (const name of COLLECTIONS) { try { store[name].ds.stopAutocompaction(); } catch (ex) { } } } });
    await store.revocations.ds.ensureIndexAsync({ fieldName: 'k', unique: true });
    return store;
}

module.exports = { openStore, COLLECTIONS, MODES };

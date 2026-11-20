/**
 * @description Outband API: runtime settings (the bearer kill switch).
 *
 * The stored value wins over the config.json startup default. Every server
 * re-reads the record at least every 5 seconds; the server that receives a
 * change applies it at once.
 * @license Apache-2.0
 */

'use strict';

const RUNTIME_ID = 'runtime';
const REFRESH_MS = 5000;

class RuntimeSettings {
    constructor(store, config, bus) {
        this.store = store; this.config = config; this.bus = bus;
        this.doc = null; this.timer = null;
    }

    async load() { await this.refresh(); }

    async refresh() {
        let doc = null;
        try { doc = await this.store.settings.findOne({ _id: RUNTIME_ID }); } catch (ex) { return; }
        const before = this.bearer();
        this.doc = doc;
        if (before && !this.bearer()) { this.bus.emit('bearer-disabled'); }
    }

    start() { if (this.timer == null) { this.timer = setInterval(() => { this.refresh(); }, REFRESH_MS); if (this.timer.unref) this.timer.unref(); } }
    stop() { if (this.timer != null) { clearInterval(this.timer); this.timer = null; } }

    bearer() { return ((this.doc != null) && (typeof this.doc.bearer == 'boolean')) ? this.doc.bearer : this.config.bearerDefault; }

    view() {
        const iso = function (ms) { return (ms == null) ? null : new Date(ms).toISOString(); };
        return {
            bearer: this.bearer(),
            bearer_source: (this.doc != null && typeof this.doc.bearer == 'boolean') ? 'runtime' : 'config',
            updated_at: (this.doc != null) ? iso(this.doc.updated) : null,
            updated_by: (this.doc != null) ? (this.doc.updated_by || null) : null
        };
    }

    async setBearer(value, byUserShortId) {
        const before = this.bearer();
        const doc = { _id: RUNTIME_ID, bearer: value, updated: Date.now(), updated_by: byUserShortId };
        await this.store.settings.upsert({ _id: RUNTIME_ID }, doc);
        this.doc = doc;
        if (before && !value) { this.bus.emit('bearer-disabled'); }
        return before;
    }
}

module.exports = { RuntimeSettings };

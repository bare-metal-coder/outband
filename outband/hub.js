/**
 * @description Outband API: the live event hub.
 *
 * Collects what the stream needs, once per server: MeshCentral's own state
 * changes (device connect/power/update/remove and logged events) and Outband
 * audit records. Entries hold only a small allowlisted copy of each event
 * and are kept for 5 minutes (at most 2000), so a reconnecting stream can
 * resume. Visibility and mapping are decided per stream, per message, at
 * delivery time.
 * @license Apache-2.0
 */

'use strict';

const EventEmitter = require('events');

const RETAIN_MS = 5 * 60000;
const RETAIN_MAX = 2000;
const DEVICE_ACTIONS = ['nodeconnect', 'addnode', 'changenode', 'removenode'];
const KEEP = ['_id', 'etype', 'action', 'time', 'nodeid', 'meshid', 'userid', 'username', 'domain', 'ip', 'nolog', 'pwr', 'conn'];

class Hub extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(0);
        /** Sequence numbers start at the boot time, so ids from an earlier run are never mistaken for current ones. */
        this.base = Math.floor(Date.now() / 1000) * 1000;
        this.seq = this.base;
        this.evicted = this.base;
        this.ring = [];
        /** nodeid -> {state, since}: power state as last seen in MeshCentral's events. */
        this.power = new Map();
    }

    /** Subscribe to MeshCentral's event dispatch. */
    attach(parent) {
        const self = this;
        if (typeof parent.AddEventDispatch != 'function') return;
        this.handler = { HandleEvent: function (source, event) { try { self.onMeshCentral(event); } catch (ex) { } } };
        parent.AddEventDispatch(['*'], this.handler);
    }

    onMeshCentral(event) {
        if ((event == null) || (typeof event != 'object') || (typeof event.action != 'string')) return;
        const isDevice = DEVICE_ACTIONS.indexOf(event.action) >= 0;
        if (!isDevice && (event.nolog || (typeof event.etype != 'string'))) return;
        const ev = {};
        for (const k of KEEP) { if (event[k] !== undefined) ev[k] = event[k]; }
        const now = Date.now();
        if (ev.time == null) ev.time = new Date(now);
        let powerChanged = false;
        if ((event.action == 'nodeconnect') && (typeof event.nodeid == 'string') && (typeof event.pwr == 'number')) {
            const prev = this.power.get(event.nodeid);
            if ((prev == null) || (prev.state !== event.pwr)) { this.power.set(event.nodeid, { state: event.pwr, since: now }); powerChanged = true; }
        }
        if ((event.action == 'removenode') && (typeof event.nodeid == 'string')) this.power.delete(event.nodeid);
        this.push({ kind: 'mc', ev: ev, powerChanged: powerChanged });
    }

    onAudit(doc) { this.push({ kind: 'audit', ev: doc, powerChanged: false }); }

    push(entry) {
        entry.seq = ++this.seq;
        entry.t = Date.now();
        this.ring.push(entry);
        this.prune();
        this.emit('entry', entry);
    }

    prune() {
        const cut = Date.now() - RETAIN_MS;
        while ((this.ring.length > 0) && ((this.ring[0].t < cut) || (this.ring.length > RETAIN_MAX))) { this.evicted = this.ring.shift().seq; }
    }

    /**
     * Entries after a Last-Event-ID, or null when the gap cannot be filled.
     * @param {number} lastSeq sequence part of the id
     */
    since(lastSeq) {
        this.prune();
        if ((lastSeq > this.seq) || (lastSeq < this.base) || (lastSeq < this.evicted)) return null;
        return this.ring.filter(function (e) { return e.seq >= lastSeq; });
    }
}

module.exports = { Hub, RETAIN_MS };

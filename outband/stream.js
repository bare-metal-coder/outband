/**
 * @description Outband API: GET /stream (Server-Sent Events).
 *
 * Wire format: `retry: 5000`, then messages with `event:` (type), `id:` (a
 * sequence number) and one `data:` line holding the envelope
 * `{"type", "data"}`. `ready`, `resync` and `closed` are control messages
 * and always sent; `types` filters the others (unknown names are ignored).
 *
 * Every message is checked with the caller's rights at the moment it is
 * sent, also when it is delivered again after a reconnect. The credential is
 * re-checked every few seconds and at once on the revocation events of
 * `core.bus`; the stream then ends with `closed` and a reason.
 * @license Apache-2.0
 */

'use strict';

const { mapEvent } = require('./mappers');
const { eventVisible } = require('./events');
const { lastSegment } = require('./util');
const { POWER_STATES } = require('./mappers');

const CONTROL = ['ready', 'resync', 'closed'];
const REASONS = ['revoked', 'expired', 'logout', 'locked', 'rights', 'disabled', 'shutdown'];
const PING_MS = 25000;
const REVALIDATE_MS = 2500;
const MAX_BACKLOG = 1 << 20;
const SLOTS = 4; // message ids are seq * SLOTS + slot

function iso(t) { return new Date(t).toISOString(); }

/** `closed` reason for a bus event reason. */
function reasonOf(r) { if (r == 'credentials_changed') return 'revoked'; return (REASONS.indexOf(r) >= 0) ? r : null; }

/** What the caller can see of this token or session: changes close the stream with `rights`. */
function fingerprint(ctx) {
    const meshes = ctx.core.webserver.meshes || {};
    const parts = [String(ctx.user.siteadmin), ctx.domainWideEvents() ? 'w' : 'n'];
    for (const id of Object.keys(meshes).sort()) { const r = ctx.meshRights(id); if (r != 0) parts.push(id + ':' + r); }
    return parts.join('|');
}

function createStream(core, hub, deps) {
    const opts = function () { return Object.assign({ pingMs: PING_MS, revalidateMs: REVALIDATE_MS }, core.streamOptions || {}); };

    /** The messages one hub entry means for this caller, as {slot, type, data}; visibility is decided now. */
    async function messagesFor(ctx, entry) {
        const out = [], ev = entry.ev;
        if (entry.kind == 'mc') {
            const nodeid = ev.nodeid, meshid = ev.meshid;
            if ((typeof nodeid == 'string') && (nodeid.split('/')[1] === ctx.domain.id)) {
                const id = lastSegment(nodeid);
                if (ev.action == 'removenode') {
                    if ((typeof meshid == 'string') && (ctx.meshRights(meshid) != 0)) out.push({ slot: 1, type: 'device.removed', data: { id: id } });
                } else if ((ev.action == 'nodeconnect') || (ev.action == 'addnode') || (ev.action == 'changenode')) {
                    const visibleBefore = (typeof meshid == 'string') && (ctx.meshRights(meshid) != 0);
                    if (visibleBefore && entry.powerChanged && (typeof ev.pwr == 'number')) {
                        out.push({ slot: 0, type: 'device.power', data: { id: id, power: { state: POWER_STATES[ev.pwr] || 'unknown', since: iso(entry.t) } } });
                    }
                    const dev = await deps.nodeMessage(ctx, nodeid);
                    if (dev) out.push({ slot: 1, type: 'device.updated', data: dev });
                    else if (visibleBefore) out.push({ slot: 1, type: 'device.removed', data: { id: id } });
                }
            }
            if (!ev.nolog && (typeof ev.etype == 'string') && eventVisible(ctx, ev)) {
                const e = mapEvent(ctx, ev);
                e.id = 'mc_' + entry.seq;
                out.push({ slot: 2, type: 'event.created', data: e });
            }
        } else if (eventVisible(ctx, ev)) {
            out.push({ slot: 2, type: 'event.created', data: mapEvent(ctx, ev) });
        }
        return out;
    }

    return async function stream(ctx, req, res, args) {
        const types = ((args.types == null) || (args.types.length == 0)) ? null : new Set(args.types);
        const wants = function (t) { return (CONTROL.indexOf(t) >= 0) || (types == null) || types.has(t); };
        const o = opts();
        let closed = false, chain = Promise.resolve(), pingTimer = null, checkTimer = null;
        let resolveDone; const done = new Promise(function (r) { resolveDone = r; });

        const write = function (s) { try { return res.write(s); } catch (ex) { return false; } };
        const send = function (type, data, id) {
            if (closed) return;
            write('event: ' + type + '\n' + ((id != null) ? ('id: ' + id + '\n') : '') + 'data: ' + JSON.stringify({ type: type, data: data }) + '\n\n');
            if (res.writableLength > MAX_BACKLOG) finish(null); // a client that does not read
        };
        const bus = core.bus;
        const listeners = [];
        const on = function (name, fn) { bus.on(name, fn); listeners.push([name, fn]); };

        function finish(reason) {
            if (closed) return;
            if (reason) send('closed', { reason: reason });
            closed = true;
            clearInterval(pingTimer); clearInterval(checkTimer);
            for (const l of listeners) bus.removeListener(l[0], l[1]);
            hub.removeListener('entry', onEntry);
            try { res.end(); } catch (ex) { }
            resolveDone();
        }

        const deliver = function (entry, afterId) {
            chain = chain.then(async function () {
                if (closed) return;
                const msgs = await messagesFor(ctx, entry);
                for (const m of msgs) {
                    const id = entry.seq * SLOTS + m.slot;
                    if ((afterId != null) && (id <= afterId)) continue;
                    if (wants(m.type)) send(m.type, m.data, id);
                }
            }).catch(function () { });
        };
        const onEntry = function (entry) { deliver(entry, null); };

        res.status(200);
        res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        try { req.socket.setTimeout(0); req.socket.setKeepAlive(true); } catch (ex) { }
        res.on('close', function () { finish(null); });
        res.on('error', function () { finish(null); });
        write('retry: 5000\n\n');

        // Revocation: the bus events (at once) and a periodic re-check.
        const endWith = function (reason) { if (reason == null) return; finish(reason); };
        on('session-ended', function (e) { if (ctx.isCookie && ctx.session && (e.userid === ctx.userid) && (e.x === ctx.session.x)) endWith(reasonOf(e.reason) || 'logout'); });
        on('token-ended', function (e) { if (ctx.isToken && (e.tokenId === ctx.token._id)) endWith(reasonOf(e.reason) || 'revoked'); });
        on('bearer-disabled', function () { if (ctx.isToken) endWith('disabled'); });
        on('shutdown', function () { endWith('shutdown'); });

        let fp = fingerprint(ctx), checking = false;
        const check = async function () {
            if (closed || checking) return;
            checking = true;
            try {
                const r = await ctx.revalidate();
                if (closed) return;
                if (r) { finish(reasonOf(r) || 'revoked'); return; }
                const now = fingerprint(ctx);
                if (now !== fp) finish('rights');
            } catch (ex) { finish('shutdown'); }
            finally { checking = false; }
        };
        checkTimer = setInterval(check, o.revalidateMs);
        pingTimer = setInterval(function () { if (!closed) write(': ping\n\n'); }, o.pingMs);

        // Start: subscribe first so nothing is missed, then ready, then resume or resync.
        hub.on('entry', onEntry);
        const startSeq = hub.seq;
        send('ready', { server_time: iso(Date.now()) });
        if (args.lastEventId != null) {
            let after = null, entries = null;
            if (/^\d{1,16}$/.test(args.lastEventId)) {
                after = parseInt(args.lastEventId, 10);
                entries = hub.since(Math.floor(after / SLOTS));
            }
            if (entries == null) send('resync', {});
            else { for (const e of entries) { if (e.seq <= startSeq) deliver(e, after); } }
        }
        await done;
    };
}

module.exports = { createStream, REASONS, SLOTS };
